import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { evictProxyDispatcher, maskProxyUrl, parseProxyImportLine, ProxyTransportError } from "~/server/utils/proxy.ts";
import { deepInfraClient } from "~/server/utils/deepinfra-client.ts";
import { stateStore, StateStore } from "~/server/utils/state-store.ts";
import type {
  ManagedAccount,
  ProxyKind,
  ProxyPoolEntry,
  ProxyPoolSettings,
} from "~/server/utils/types.ts";

const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

export type ProxyPoolStatus = "idle" | "checking" | "in_use" | "error";

export interface ProxyPoolPublicEntry {
  id: string;
  kind: ProxyKind;
  source: "manual" | "rola_free";
  lifecycle: "active" | "failed" | "archived";
  failureCount: number;
  label?: string;
  maskedUrl: string;
  status: ProxyPoolStatus;
  accountId?: string;
  accountLabel?: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  failedAt?: string;
  retryAfter?: number;
}

export interface ProxyImportLineResult {
  line: number;
  source: string;
  status: "created" | "existing" | "invalid";
  entry?: ProxyPoolPublicEntry;
  error?: string;
}

export interface ProxyAssignmentResult {
  account: ManagedAccount;
  entry?: ProxyPoolEntry;
  direct: boolean;
}

export interface ProxyPoolDependencies {
  store: StateStore;
  checkProxy(proxy: string, signal?: AbortSignal): Promise<void>;
  now(): number;
  notifyScheduler(): void;
}

const productionDependencies: ProxyPoolDependencies = {
  store: stateStore,
  checkProxy: deepInfraClient.checkProxy,
  now: () => Date.now(),
  notifyScheduler: () => accountScheduler.notifyStateChanged(),
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Unknown proxy health failure.";
}

export class ProxyPoolService {
  private readonly reservations = new Set<string>();

  constructor(private readonly dependencies: ProxyPoolDependencies = productionDependencies) {}

  async importText(text: string, defaultProtocol: ProxyKind): Promise<ProxyImportLineResult[]> {
    if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) {
      throw new Error(`Proxy import exceeds ${MAX_IMPORT_BYTES} bytes.`);
    }
    const lines = text.split(/\r?\n/);

    const parsed: Array<{ line: number; inputText: string; url: string; kind: ProxyKind }> = [];
    const results: ProxyImportLineResult[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const inputText = lines[index]!.trim();
      if (!inputText) continue;
      try {
        const proxy = parseProxyImportLine(inputText, defaultProtocol);
        parsed.push({ line: index + 1, inputText, url: proxy.url, kind: proxy.kind });
      } catch (error) {
        results.push({ line: index + 1, source: `Line ${index + 1}`, status: "invalid", error: errorText(error) });
      }
    }

    const imported = await this.dependencies.store.importProxyPool(parsed);
    const snapshot = await this.snapshot();
    const byId = new Map(snapshot.map((entry) => [entry.id, entry]));
    for (let index = 0; index < parsed.length; index += 1) {
      const source = parsed[index]!;
      const outcome = imported[index]!;
      results.push({
        line: source.line,
        source: maskProxyUrl(outcome.entry.url),
        status: outcome.created ? "created" : "existing",
        entry: byId.get(outcome.entry.id),
      });
    }
    return results.sort((left, right) => left.line - right.line);
  }

  async snapshot(): Promise<ProxyPoolPublicEntry[]> {
    const [entries, accounts] = await Promise.all([
      this.dependencies.store.listProxyPool(),
      this.dependencies.store.listAccounts(),
    ]);
    const byEntry = new Map(accounts
      .filter((account) => account.proxyPoolEntryId)
      .map((account) => [account.proxyPoolEntryId!, account]));
    return entries.map((entry) => {
      const account = byEntry.get(entry.id);
      const status: ProxyPoolStatus = this.reservations.has(entry.id)
        ? "checking"
        : entry.lastError
          ? "error"
          : account
            ? "in_use"
            : "idle";
      return {
        id: entry.id,
        kind: entry.kind,
        source: entry.source,
        lifecycle: entry.lifecycle,
        failureCount: entry.failureCount,
        ...(entry.label ? { label: entry.label } : {}),
        maskedUrl: maskProxyUrl(entry.url),
        status,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ...(entry.lastCheckedAt ? { lastCheckedAt: entry.lastCheckedAt } : {}),
        ...(entry.lastHealthyAt ? { lastHealthyAt: entry.lastHealthyAt } : {}),
        ...(entry.lastError ? { lastError: entry.lastError } : {}),
        ...(entry.failedAt ? { failedAt: entry.failedAt } : {}),
        ...(entry.archivedAt ? { archivedAt: entry.archivedAt } : {}),
        ...(entry.retryAfter ? { retryAfter: entry.retryAfter } : {}),
        ...(account ? { accountId: account.id, accountLabel: account.label } : {}),
      };
    });
  }

  async check(entryId: string, signal?: AbortSignal): Promise<ProxyPoolEntry> {
    if (this.reservations.has(entryId)) throw new Error("Proxy pool entry is already being checked.");
    this.reservations.add(entryId);
    try {
      const entry = await this.dependencies.store.getProxyPoolEntry(entryId);
      if (!entry) throw new Error("Proxy pool entry not found.");
      return await this.checkReserved(entry, signal);
    } finally {
      this.reservations.delete(entryId);
    }
  }

  async checkMany(scope: "error" | "all", signal?: AbortSignal): Promise<Array<{ id: string; healthy: boolean; error?: string }>> {
    const entries = await this.dependencies.store.listProxyPool();
    const selected = scope === "error" ? entries.filter((entry) => entry.lastError) : entries;
    const results: Array<{ id: string; healthy: boolean; error?: string }> = [];
    for (const entry of selected) {
      if (signal?.aborted) break;
      try {
        await this.check(entry.id, signal);
        results.push({ id: entry.id, healthy: true });
      } catch (error) {
        results.push({ id: entry.id, healthy: false, error: errorText(error) });
      }
    }
    return results;
  }

  async assignIdle(accountId: string, options?: {
    expectedCurrentEntryId?: string | null;
    expectedCurrentProxy?: string;
    excludeEntryIds?: ReadonlySet<string>;
    signal?: AbortSignal;
  }): Promise<ProxyAssignmentResult | undefined> {
    const expected = options?.expectedCurrentEntryId ?? null;
    const excluded = options?.excludeEntryIds ?? new Set<string>();
    while (!options?.signal?.aborted) {
      const candidate = await this.reserveCandidate(excluded);
      if (!candidate) return undefined;
      try {
        await this.checkReserved(candidate, options?.signal);
        const account = options?.expectedCurrentProxy
          ? await this.dependencies.store.assignProxyPoolEntryFromProxy(accountId, candidate.id, options.expectedCurrentProxy)
          : await this.dependencies.store.assignProxyPoolEntry(accountId, candidate.id, expected);
        this.dependencies.notifyScheduler();
        return { account, entry: candidate, direct: false };
      } catch (error) {
        if (!(error instanceof ProxyTransportError)) {
          // A concurrent assignment race means select another candidate. Other
          // state errors (account changed/deleted) are terminal.
          if (error instanceof Error && /already assigned/.test(error.message)) {
            continue;
          }
          throw error;
        }
      } finally {
        this.reservations.delete(candidate.id);
      }
    }
    return undefined;
  }

  async rotateCustom(account: ManagedAccount, error: ProxyTransportError, signal?: AbortSignal): Promise<ProxyAssignmentResult | undefined> {
    if (!account.proxy || account.proxyPoolEntryId) return undefined;
    const settings = (await this.dependencies.store.getSettings()).proxyPool;
    if (!settings.autoRotateOnTransportError) return undefined;
    try {
      const replacement = await this.assignIdle(account.id, {
        expectedCurrentProxy: account.proxy,
        signal,
      });
      if (replacement) return replacement;
    } catch (assignmentError) {
      if (assignmentError instanceof Error && /binding changed/.test(assignmentError.message)) {
        const current = await this.dependencies.store.getAccount(account.id);
        if (!current) throw assignmentError;
        if (current.proxyPoolEntryId) {
          const entry = await this.dependencies.store.getProxyPoolEntry(current.proxyPoolEntryId);
          return { account: current, ...(entry ? { entry } : {}), direct: false };
        }
        if (!current.proxy) return { account: current, direct: true };
      }
      throw assignmentError;
    }
    const syncSettings = await this.dependencies.store.getProxySyncSettings();
    if (syncSettings.enabled || !settings.directFallbackWhenExhausted) return undefined;
    const direct = await this.dependencies.store.clearCustomProxyIfMatches(account.id, account.proxy);
    this.dependencies.notifyScheduler();
    void error;
    return { account: direct, direct: true };
  }

  async rotate(
    accountId: string,
    failedEntryId: string,
    error: ProxyTransportError,
    signal?: AbortSignal,
  ): Promise<ProxyAssignmentResult | undefined> {
    const settings = (await this.dependencies.store.getSettings()).proxyPool;
    const failed = await this.dependencies.store.getProxyPoolEntry(failedEntryId);
    if (failed) await this.markError(failed, error);
    if (!settings.autoRotateOnTransportError) return undefined;

    let replacement: ProxyAssignmentResult | undefined;
    try {
      replacement = await this.assignIdle(accountId, {
        expectedCurrentEntryId: failedEntryId,
        excludeEntryIds: new Set([failedEntryId]),
        signal,
      });
    } catch (assignmentError) {
      if (assignmentError instanceof Error && /binding changed/.test(assignmentError.message)) {
        const current = await this.dependencies.store.getAccount(accountId);
        if (!current) throw assignmentError;
        if (current.proxyPoolEntryId && current.proxyPoolEntryId !== failedEntryId) {
          const entry = await this.dependencies.store.getProxyPoolEntry(current.proxyPoolEntryId);
          return { account: current, ...(entry ? { entry } : {}), direct: false };
        }
        if (!current.proxy && !current.proxyPoolEntryId) return { account: current, direct: true };
      }
      throw assignmentError;
    }
    if (replacement) return replacement;
    const syncSettings = await this.dependencies.store.getProxySyncSettings();
    if (syncSettings.enabled || !settings.directFallbackWhenExhausted) return undefined;

    const account = await this.dependencies.store.unbindProxyPoolEntry(accountId, failedEntryId);
    this.dependencies.notifyScheduler();
    return { account, direct: true };
  }

  async markBoundProxyError(account: ManagedAccount, error: unknown): Promise<void> {
    if (!account.proxyPoolEntryId) return;
    const entry = await this.dependencies.store.getProxyPoolEntry(account.proxyPoolEntryId);
    if (!entry) return;
    await this.markError(entry, error);
  }

  async delete(entryId: string): Promise<void> {
    if (this.reservations.has(entryId)) throw new Error("Proxy pool entry is being checked.");
    const entry = await this.dependencies.store.getProxyPoolEntry(entryId);
    if (!entry) throw new Error("Proxy pool entry not found.");
    this.reservations.add(entryId);
    try {
      await this.dependencies.store.deleteProxyPoolEntry(entryId);
      await evictProxyDispatcher(entry.url);
    } finally {
      this.reservations.delete(entryId);
    }
  }

  isChecking(entryId: string): boolean {
    return this.reservations.has(entryId);
  }

  resetForTests(): void {
    this.reservations.clear();
  }

  private async reserveCandidate(excluded: ReadonlySet<string>): Promise<ProxyPoolEntry | undefined> {
    const [entries, accounts, settings] = await Promise.all([
      this.dependencies.store.listProxyPool(),
      this.dependencies.store.listAccounts(),
      this.dependencies.store.getSettings(),
    ]);
    const assigned = new Set(accounts.map((account) => account.proxyPoolEntryId).filter((id): id is string => Boolean(id)));
    const now = this.dependencies.now();
    const candidates = entries
      .filter((entry) => !assigned.has(entry.id) && !this.reservations.has(entry.id) && !excluded.has(entry.id))
      .filter((entry) => !entry.lastError || (entry.retryAfter ?? 0) <= now)
      .sort((left, right) => {
        // Healthy/never-failed idle proxies always precede recovered error
        // candidates. Error entries are fallback probes after normal idle pool.
        const errorDifference = Number(Boolean(left.lastError)) - Number(Boolean(right.lastError));
        if (errorDifference !== 0) return errorDifference;
        const leftHealthy = left.lastHealthyAt ?? "";
        const rightHealthy = right.lastHealthyAt ?? "";
        if (leftHealthy !== rightHealthy) return leftHealthy.localeCompare(rightHealthy);
        return left.createdAt.localeCompare(right.createdAt);
      });
    const candidate = candidates[0];
    if (!candidate) return undefined;
    this.reservations.add(candidate.id);
    // Keep settings read in this decision so cooldown hot updates are observed.
    void settings.proxyPool.errorRetryCooldownSeconds;
    return candidate;
  }

  private async checkReserved(entry: ProxyPoolEntry, signal?: AbortSignal): Promise<ProxyPoolEntry> {
    const checkedAt = new Date(this.dependencies.now()).toISOString();
    const settings = (await this.dependencies.store.getSettings()).proxyPool;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.healthCheckTimeoutSeconds * 1_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.dependencies.checkProxy(entry.url, controller.signal);
      return await this.dependencies.store.updateProxyPoolHealth(entry.id, { healthy: true, checkedAt });
    } catch (error) {
      if (signal?.aborted) throw error;
      const transport = error instanceof ProxyTransportError
        ? error
        : new ProxyTransportError(
            controller.signal.aborted ? "Proxy health check timed out." : errorText(error),
            { cause: error },
          );
      await this.markError(entry, transport, checkedAt);
      throw transport;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async markError(entry: ProxyPoolEntry, error: unknown, checkedAt = new Date(this.dependencies.now()).toISOString()): Promise<void> {
    const settings: ProxyPoolSettings = (await this.dependencies.store.getSettings()).proxyPool;
    await evictProxyDispatcher(entry.url);
    await this.dependencies.store.updateProxyPoolHealth(entry.id, {
      healthy: false,
      checkedAt,
      error: errorText(error),
      retryAfter: this.dependencies.now() + settings.errorRetryCooldownSeconds * 1_000,
    });
  }
}

export const proxyPoolService = new ProxyPoolService();
