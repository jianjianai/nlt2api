import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { ProxyTransportError } from "../server/utils/proxy.ts";
import { ProxySyncService } from "../server/utils/proxy-sync.ts";
import { StateStore } from "../server/utils/state-store.ts";
import type { RolaProxyCandidate } from "../server/utils/rola-proxy-source.ts";

async function withStore<T>(run: (store: StateStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "proxy-sync-test-"));
  const previous = process.env.DEEPINFRA_GATEWAY_DATA_DIR;
  process.env.DEEPINFRA_GATEWAY_DATA_DIR = dir;
  resetProxyConfigForTests();
  try { return await run(new StateStore()); }
  finally {
    if (previous === undefined) delete process.env.DEEPINFRA_GATEWAY_DATA_DIR;
    else process.env.DEEPINFRA_GATEWAY_DATA_DIR = previous;
    resetProxyConfigForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

function candidate(url: string): RolaProxyCandidate {
  const parsed = new URL(url);
  return {
    url,
    kind: url.startsWith("socks4") ? "socks4" : url.startsWith("socks") ? "socks5" : "http",
    ip: parsed.hostname,
    port: Number(parsed.port),
    protocol: url.startsWith("socks4") ? "SOCKS4" : url.startsWith("socks") ? "SOCKS5" : "HTTP",
    metadata: { sourceUrl: "test", reportedLatencyMs: 10, reportedUptimePercent: 100 },
  };
}

test("proxy sync replaces the proxy on the same account and preserves billing identity", async () => {
  await withStore(async (store) => {
    const account = await store.addAccount({ label: "Stable", proxy: "socks5h://8.8.8.8:1080", models: ["moonshotai/Kimi-K3"], weight: 9 });
    const [old] = await store.importProxyPool([{ url: account.proxy!, kind: "socks5" }]);
    await store.assignProxyPoolEntryFromProxy(account.id, old!.entry.id, account.proxy!);
    await store.updateProxySyncSettings({ targetAccountCount: 1, failureThreshold: 1, candidateLimit: 5, probeConcurrency: 2 });
    const service = new ProxySyncService({
      store,
      fetchCandidates: async () => [candidate("socks5h://1.1.1.1:1080")],
      checkProxy: async () => undefined,
      probeChat: async () => undefined,
      probeProxy: async (proxy) => { if (proxy.includes("8.8.8.8")) throw new ProxyTransportError("dead"); },
      notifyScheduler: () => undefined,
      now: () => Date.now(),
    });
    const run = await service.run("manual");
    const updated = await store.getAccount(account.id);
    assert.equal(run.status, "completed");
    assert.equal(updated?.id, account.id);
    assert.equal(updated?.proxy, "socks5h://1.1.1.1:1080");
    assert.equal(updated?.weight, 9);
    assert.deepEqual(updated?.models, ["moonshotai/Kimi-K3"]);
    assert.equal(run.counts.replaced, 1);
    const runs = await store.listProxySyncRuns();
    assert.equal(runs[0]?.status, "completed");
    assert.ok((await store.listProxyPool()).some((entry) => entry.lifecycle === "archived"));
  });
});

test("proxy sync keeps account unavailable when no replacement is healthy", async () => {
  await withStore(async (store) => {
    const account = await store.addAccount({ label: "Stable", proxy: "socks5h://8.8.8.8:1080" });
    await store.updateProxySyncSettings({ targetAccountCount: 1, failureThreshold: 1 });
    const service = new ProxySyncService({
      store,
      fetchCandidates: async () => [],
      checkProxy: async () => undefined,
      probeChat: async () => undefined,
      probeProxy: async () => { throw new ProxyTransportError("dead"); },
      notifyScheduler: () => undefined,
      now: () => Date.now(),
    });
    await service.run("manual");
    const updated = await store.getAccount(account.id);
    assert.equal(updated?.id, account.id);
    assert.equal(updated?.proxy, account.proxy);
    assert.equal(updated?.egressStatus, "unavailable");
  });
});

test("concurrent manual triggers share one active synchronization run", async () => {
  await withStore(async (store) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new ProxySyncService({
      store,
      fetchCandidates: async () => { await gate; return []; },
      checkProxy: async () => undefined,
      probeChat: async () => undefined,
      probeProxy: async () => undefined,
      notifyScheduler: () => undefined,
      now: () => Date.now(),
    });
    const snapshot = service.start("manual");
    assert.equal(snapshot.status, "running");
    assert.equal(service.currentRun()?.id, snapshot.id);
    const first = service.run("manual");
    const second = service.run("manual");
    assert.equal(first, second);
    release();
    assert.equal((await first).id, (await second).id);
  });
});
