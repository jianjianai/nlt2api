import { randomUUID } from "node:crypto";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { deepInfraClient } from "~/server/utils/deepinfra-client.ts";
import { egressIdentity, ProxyTransportError } from "~/server/utils/proxy.ts";
import { fetchRolaProxyCandidates, ROLA_FREE_PROXY_URL, type RolaProxyCandidate } from "~/server/utils/rola-proxy-source.ts";
import { stateStore, type StateStore } from "~/server/utils/state-store.ts";
import type { ManagedAccount, ProxyPoolEntry, ProxySyncRun, ProxySyncRunDetail, ProxySyncRunTrigger, ProxySyncSettings } from "~/server/utils/types.ts";

interface ProxySyncDependencies {
  store: StateStore;
  fetchCandidates(signal?: AbortSignal): Promise<RolaProxyCandidate[]>;
  checkProxy(proxy: string, signal?: AbortSignal): Promise<void>;
  probeChat(proxy: string, signal?: AbortSignal): Promise<void>;
  probeProxy(proxy: string, signal?: AbortSignal): Promise<void>;
  notifyScheduler(): void;
  now(): number;
}

const productionDependencies: ProxySyncDependencies = {
  store: stateStore,
  fetchCandidates: fetchRolaProxyCandidates,
  checkProxy: deepInfraClient.checkProxy,
  probeChat: deepInfraClient.probeChat,
  probeProxy: deepInfraClient.probeProxy,
  notifyScheduler: () => accountScheduler.notifyStateChanged(),
  now: () => Date.now(),
};

function emptyCounts(): ProxySyncRun["counts"] {
  return { fetched: 0, parsed: 0, skipped: 0, probed: 0, healthy: 0, failed: 0, replaced: 0, archived: 0, created: 0 };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown proxy synchronization failure.";
}

async function withTimeout<T>(seconds: number, operation: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), seconds * 1_000);
  const abort = () => controller.abort();
  if (outer?.aborted) abort();
  else outer?.addEventListener("abort", abort, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    outer?.removeEventListener("abort", abort);
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ProxySyncService {
  private active: Promise<ProxySyncRun> | undefined;
  private activeRun: ProxySyncRun | undefined;

  constructor(private readonly dependencies: ProxySyncDependencies = productionDependencies) {}

  currentRun(): ProxySyncRun | undefined {
    return this.activeRun ? structuredClone(this.activeRun) : undefined;
  }

  async status(): Promise<{ settings: ProxySyncSettings; current?: ProxySyncRun; latest?: ProxySyncRun }> {
    const [settings, runs] = await Promise.all([
      this.dependencies.store.getProxySyncSettings(),
      this.dependencies.store.listProxySyncRuns(),
    ]);
    return { settings, ...(this.activeRun ? { current: structuredClone(this.activeRun) } : {}), ...(runs[0] ? { latest: runs[0] } : {}) };
  }

  start(trigger: ProxySyncRunTrigger, signal?: AbortSignal): ProxySyncRun {
    if (this.activeRun) return structuredClone(this.activeRun);
    void this.run(trigger, signal);
    return structuredClone(this.activeRun!);
  }

  run(trigger: ProxySyncRunTrigger, signal?: AbortSignal): Promise<ProxySyncRun> {
    if (this.active) return this.active;
    const run: ProxySyncRun = {
      id: `psync_${randomUUID().replaceAll("-", "")}`,
      trigger,
      status: "running",
      startedAt: new Date(this.dependencies.now()).toISOString(),
      sourceUrl: ROLA_FREE_PROXY_URL,
      counts: emptyCounts(),
      details: [],
    };
    this.activeRun = run;
    this.active = this.execute(run, signal).finally(() => {
      this.active = undefined;
      this.activeRun = undefined;
    });
    return this.active;
  }

  private async execute(run: ProxySyncRun, signal?: AbortSignal): Promise<ProxySyncRun> {
    await this.dependencies.store.saveProxySyncRun(run);
    try {
      const settings = await this.dependencies.store.getProxySyncSettings();
      const fetched = await this.dependencies.fetchCandidates(signal);
      run.counts.fetched = fetched.length;
      run.counts.parsed = fetched.length;
      const [accounts, pool] = await Promise.all([
        this.dependencies.store.listAccounts(),
        this.dependencies.store.listProxyPool(),
      ]);
      const managedAccounts = accounts.filter((account) => account.proxy);
      const occupied = new Set(accounts.filter((account) => account.proxy).map((account) => egressIdentity(account.proxy).key));
      const cooldownMs = settings.archiveCooldownHours * 60 * 60_000;
      const blockedByEgress = new Map(pool.filter((entry) =>
        entry.lifecycle === "archived" && entry.archivedAt || entry.lifecycle === "failed" && entry.retryAfter)
        .map((entry) => [egressIdentity(entry.url).key, entry.lifecycle === "archived" ? Date.parse(entry.archivedAt!) + cooldownMs : entry.retryAfter!]));
      const candidates = fetched.filter((candidate) => {
        const key = egressIdentity(candidate.url).key;
        if (occupied.has(key)) return false;
        const blockedUntil = blockedByEgress.get(key);
        return blockedUntil === undefined || blockedUntil <= this.dependencies.now();
      }).slice(0, settings.candidateLimit);
      run.counts.skipped = Math.max(0, fetched.length - candidates.length);

      const minterCount = Math.max(1, Number(process.env.DEEPINFRA_TURNSTILE_MINTERS ?? "2"));
      const unhealthy: Array<{ account: ManagedAccount; reason: string }> = [];
      await mapConcurrent(managedAccounts, Math.min(settings.probeConcurrency, minterCount), async (account) => {
        if (signal?.aborted) return;
        const currentProxy = account.proxy;
        if (!currentProxy) return;
        run.counts.probed += 1;
        try {
          await withTimeout(settings.probeTimeoutSeconds, (probeSignal) => this.dependencies.probeProxy(currentProxy, probeSignal), signal);
          run.counts.healthy += 1;
          if (account.proxyPoolEntryId) {
            await this.dependencies.store.updateProxyPoolHealth(account.proxyPoolEntryId, { healthy: true, checkedAt: new Date(this.dependencies.now()).toISOString() });
          }
          if (account.egressStatus !== "active") await this.dependencies.store.setAccountEgressStatus(account.id, "active");
        } catch (error) {
          const reason = errorText(error);
          if (!(error instanceof ProxyTransportError)) {
            run.details.push({ accountId: account.id, candidate: currentProxy, status: "skipped", reason });
            return;
          }
          run.counts.failed += 1;
          let failures = settings.failureThreshold;
          let poolEntryId = account.proxyPoolEntryId;
          if (!poolEntryId) {
            const canonicalKind = currentProxy.startsWith("socks4") ? "socks4" : currentProxy.startsWith("socks") ? "socks5" : "http";
            const [imported] = await this.dependencies.store.importProxyPool([{ url: currentProxy, kind: canonicalKind, source: "manual" }]);
            await this.dependencies.store.assignProxyPoolEntryFromProxy(account.id, imported!.entry.id, currentProxy);
            poolEntryId = imported!.entry.id;
          }
          if (poolEntryId) {
            const entry = await this.dependencies.store.getProxyPoolEntry(poolEntryId);
            if (entry) {
              const failed = await this.dependencies.store.updateProxyPoolHealth(entry.id, {
                healthy: false,
                checkedAt: new Date(this.dependencies.now()).toISOString(),
                error: reason,
                retryAfter: this.dependencies.now() + settings.probeTimeoutSeconds * 1_000,
              });
              failures = failed.failureCount;
            }
          }
          run.details.push({ accountId: account.id, candidate: currentProxy, status: "failed", reason });
          if (failures >= settings.failureThreshold) unhealthy.push({ account, reason });
        }
      });

      const inheritedModels = managedAccounts.find((account) => account.models.length > 0)?.models ?? [];
      const neededCapacity = Math.max(0, settings.targetAccountCount - managedAccounts.length);
      const neededHealthy = Math.min(candidates.length, unhealthy.length + neededCapacity);
      const catalogCandidates = await mapConcurrent(candidates, settings.probeConcurrency, async (candidate) => {
        if (signal?.aborted) return { candidate, healthy: false, error: "Sync aborted.", durationMs: 0 };
        run.counts.probed += 1;
        const started = this.dependencies.now();
        try {
          await withTimeout(settings.probeTimeoutSeconds, (probeSignal) => this.dependencies.checkProxy(candidate.url, probeSignal), signal);
          return { candidate, healthy: true, durationMs: this.dependencies.now() - started };
        } catch (error) {
          const proxyFailure = error instanceof ProxyTransportError;
          if (proxyFailure) run.counts.failed += 1;
          return { candidate, healthy: false, proxyFailure, error: errorText(error), durationMs: this.dependencies.now() - started };
        }
      });
      const chatCandidates = catalogCandidates.filter((result) => result.healthy);
      const probedCandidates = await mapConcurrent(chatCandidates, Math.min(settings.probeConcurrency, minterCount), async (result) => {
        const started = this.dependencies.now();
        try {
          await withTimeout(settings.probeTimeoutSeconds + 30, (probeSignal) => this.dependencies.probeChat(result.candidate.url, probeSignal), signal);
          run.counts.healthy += 1;
          return { candidate: result.candidate, healthy: true, durationMs: result.durationMs + this.dependencies.now() - started };
        } catch (error) {
          const proxyFailure = error instanceof ProxyTransportError;
          if (proxyFailure) run.counts.failed += 1;
          return { candidate: result.candidate, healthy: false, proxyFailure, error: errorText(error), durationMs: result.durationMs + this.dependencies.now() - started };
        }
      });
      const allCandidateResults = [...catalogCandidates.filter((result) => !result.healthy), ...probedCandidates];
      const healthyCandidates = probedCandidates.filter((result) => result.healthy).slice(0, neededHealthy);
      for (const result of allCandidateResults) {
        const [imported] = await this.dependencies.store.importProxyPool([{
          url: result.candidate.url,
          kind: result.candidate.kind,
          source: "rola_free",
          sourceMetadata: result.candidate.metadata,
        }]);
        if (result.healthy) {
          await this.dependencies.store.updateProxyPoolHealth(imported!.entry.id, { healthy: true, checkedAt: new Date(this.dependencies.now()).toISOString() });
        } else if (result.proxyFailure) {
          await this.dependencies.store.updateProxyPoolHealth(imported!.entry.id, {
            healthy: false,
            checkedAt: new Date(this.dependencies.now()).toISOString(),
            error: result.error ?? "Proxy probe failed.",
            retryAfter: this.dependencies.now() + settings.archiveCooldownHours * 60 * 60_000,
          });
        }
        run.details.push({ candidate: result.candidate.url, status: result.healthy ? "healthy" : result.proxyFailure ? "failed" : "skipped", ...(result.error ? { reason: result.error } : {}), durationMs: result.durationMs });
      }

      let cursor = 0;
      for (const failed of unhealthy) {
        const candidate = healthyCandidates[cursor++];
        if (!candidate) {
          await this.dependencies.store.setAccountEgressStatus(failed.account.id, "unavailable");
          continue;
        }
        await this.dependencies.store.setAccountEgressStatus(failed.account.id, "replacing");
        const [imported] = await this.dependencies.store.importProxyPool([{
          url: candidate.candidate.url,
          kind: candidate.candidate.kind,
          source: "rola_free",
          sourceMetadata: candidate.candidate.metadata,
        }]);
        const replacement = await this.dependencies.store.replaceAccountProxy(failed.account.id, failed.account.proxy!, imported!.entry.id, failed.reason);
        run.counts.replaced += 1;
        run.counts.archived += 1;
        run.details.push({ accountId: failed.account.id, oldProxyId: replacement.archived.id, newProxyId: replacement.replacement.id, status: "replaced", reason: failed.reason });
      }

      while (cursor < healthyCandidates.length && run.counts.created < neededCapacity) {
        const candidate = healthyCandidates[cursor++]!;
        const [imported] = await this.dependencies.store.importProxyPool([{
          url: candidate.candidate.url,
          kind: candidate.candidate.kind,
          source: "rola_free",
          sourceMetadata: candidate.candidate.metadata,
        }]);
        const models = inheritedModels.length > 0
          ? [...inheritedModels]
          : (await deepInfraClient.models(signal, candidate.candidate.url)).filter((model) => model.freeForAnonymous).map((model) => model.id);
        const account = await this.dependencies.store.createProxyAccountFromEntry(imported!.entry.id, `Rola ${candidate.candidate.ip}`, models);
        run.counts.created += 1;
        run.details.push({ accountId: account.id, newProxyId: imported!.entry.id, status: "created" });
      }

      await this.dependencies.store.pruneArchivedProxyPool(this.dependencies.now() - settings.archiveCooldownHours * 60 * 60_000);
      run.status = "completed";
      run.completedAt = new Date(this.dependencies.now()).toISOString();
      this.dependencies.notifyScheduler();
    } catch (error) {
      run.status = signal?.aborted ? "interrupted" : "failed";
      run.error = errorText(error);
      run.completedAt = new Date(this.dependencies.now()).toISOString();
    }
    run.details = run.details.slice(-2_000);
    await this.dependencies.store.saveProxySyncRun(run);
    return structuredClone(run);
  }
}

export const proxySyncService = new ProxySyncService();
