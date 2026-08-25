import deleteProxyHandler from "../server/api/admin/proxies/[id].delete.ts";
import checkProxyHandler from "../server/api/admin/proxies/[id]/check.post.ts";
import assignProxyHandler from "../server/api/admin/accounts/[id]/assign-proxy.post.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deepInfraClient } from "../server/utils/deepinfra-client.ts";
import { ProxyPoolService, proxyPoolService } from "../server/utils/proxy-pool.ts";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { ProxyTransportError } from "../server/utils/proxy.ts";
import { stateStore, StateStore } from "../server/utils/state-store.ts";

type TestHandler = (event: { req: Request; context: { params?: Record<string, string> } }) => Promise<Response>;

function adminEvent(id?: string, token = "test-admin"): { req: Request; context: { params?: Record<string, string> } } {
  return {
    req: new Request("http://localhost/api/admin/test", { headers: { "x-admin-token": token } }),
    context: { ...(id ? { params: { id } } : {}) },
  };
}

async function withAdminStore<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "deepinfra-proxy-admin-test-"));
  const previousDir = process.env.DEEPINFRA_GATEWAY_DATA_DIR;
  const previousToken = process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN;
  process.env.DEEPINFRA_GATEWAY_DATA_DIR = dir;
  process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN = "test-admin";
  resetProxyConfigForTests();
  stateStore.resetForTests();
  proxyPoolService.resetForTests();
  try {
    return await run();
  } finally {
    if (previousDir === undefined) delete process.env.DEEPINFRA_GATEWAY_DATA_DIR;
    else process.env.DEEPINFRA_GATEWAY_DATA_DIR = previousDir;
    if (previousToken === undefined) delete process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN;
    else process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN = previousToken;
    resetProxyConfigForTests();
    stateStore.resetForTests();
    proxyPoolService.resetForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

async function withPool<T>(
  run: (context: { store: StateStore; service: ProxyPoolService; notifications: () => number }) => Promise<T>,
  checkProxy: (proxy: string, signal?: AbortSignal) => Promise<void> = async () => {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "deepinfra-proxy-pool-test-"));
  const previous = process.env.DEEPINFRA_GATEWAY_DATA_DIR;
  process.env.DEEPINFRA_GATEWAY_DATA_DIR = dir;
  resetProxyConfigForTests();
  const store = new StateStore();
  let notificationCount = 0;
  const service = new ProxyPoolService({
    store,
    checkProxy,
    now: () => Date.now(),
    notifyScheduler: () => { notificationCount += 1; },
  });
  try {
    return await run({ store, service, notifications: () => notificationCount });
  } finally {
    if (previous === undefined) delete process.env.DEEPINFRA_GATEWAY_DATA_DIR;
    else process.env.DEEPINFRA_GATEWAY_DATA_DIR = previous;
    resetProxyConfigForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

test("proxy admin handlers expose authentication, not-found, conflict and transport statuses", async () => {
  await withAdminStore(async () => {
    const deleteHandler = deleteProxyHandler as unknown as TestHandler;
    const checkHandler = checkProxyHandler as unknown as TestHandler;
    const assignHandler = assignProxyHandler as unknown as TestHandler;

    assert.equal((await deleteHandler(adminEvent("missing", "wrong"))).status, 401);
    assert.equal((await deleteHandler(adminEvent("missing"))).status, 404);
    assert.equal((await checkHandler(adminEvent("missing"))).status, 404);

    const [pool] = await stateStore.importProxyPool([{ url: "http://bound.local:8080/", kind: "http" }]);
    const boundAccount = await stateStore.addAccount({ label: "bound@example.com" });
    await stateStore.bindProxyPoolEntry(boundAccount.id, pool!.entry.id);
    assert.equal((await deleteHandler(adminEvent(pool!.entry.id))).status, 409);
    assert.equal((await assignHandler(adminEvent(boundAccount.id))).status, 409);

    const [unhealthy] = await stateStore.importProxyPool([{ url: "http://offline.local:8080/", kind: "http" }]);
    const originalCheckProxy = deepInfraClient.checkProxy;
    deepInfraClient.checkProxy = async () => { throw new ProxyTransportError("offline"); };
    try {
      assert.equal((await checkHandler(adminEvent(unhealthy!.entry.id))).status, 502);
    } finally {
      deepInfraClient.checkProxy = originalCheckProxy;
    }
  });
});

test("createAccounts consumes healthy idle proxies and writes models", async () => {
  await withPool(async ({ store, service }) => {
    const imported = await service.importText("one.local:8080\ntwo.local:8080", "http");
    for (const item of imported) await store.updateProxyPoolHealth(item.entry!.id, { healthy: true, checkedAt: new Date().toISOString() });
    const originalProbe = deepInfraClient.probeProxy;
    const originalModels = deepInfraClient.models;
    deepInfraClient.probeProxy = async () => undefined;
    deepInfraClient.models = async () => [{ id: "moonshotai/Kimi-K3", freeForAnonymous: true }];
    try {
      const result = await service.createAccounts(2);
      assert.equal(result.accounts.length, 2);
      assert.equal(result.requested, 2);
      assert.equal(new Set(result.accounts.map((account) => account.proxy)).size, 2);
      assert.equal(result.accounts.every((account) => account.models.includes("moonshotai/Kimi-K3")), true);
      assert.equal((await store.listAccounts()).length, 2);
    } finally {
      deepInfraClient.probeProxy = originalProbe;
      deepInfraClient.models = originalModels;
    }
  });
});

test("createAccounts skips failed proxies and reports partial capacity", async () => {
  await withPool(async ({ store, service }) => {
    const imported = await service.importText("bad.local:8080\ngood.local:8080", "http");
    for (const item of imported) await store.updateProxyPoolHealth(item.entry!.id, { healthy: true, checkedAt: new Date().toISOString() });
    const originalProbe = deepInfraClient.probeProxy;
    const originalModels = deepInfraClient.models;
    deepInfraClient.probeProxy = async (proxy) => { if (proxy.includes("bad.local")) throw new ProxyTransportError("offline"); };
    deepInfraClient.models = async () => [{ id: "moonshotai/Kimi-K3", freeForAnonymous: true }];
    try {
      const result = await service.createAccounts(2);
      assert.equal(result.accounts.length, 1);
      assert.equal(result.failed.length, 1);
    } finally {
      deepInfraClient.probeProxy = originalProbe;
      deepInfraClient.models = originalModels;
    }
  });
});

test("createAccounts probes imported proxies on demand", async () => {
  await withPool(async ({ store, service }) => {
    await service.importText("untested.local:8080", "http");
    const originalProbe = deepInfraClient.probeProxy;
    const originalModels = deepInfraClient.models;
    deepInfraClient.probeProxy = async () => undefined;
    deepInfraClient.models = async () => [{ id: "moonshotai/Kimi-K3", freeForAnonymous: true }];
    try {
      const result = await service.createAccounts(1);
      assert.equal(result.accounts.length, 1);
      assert.equal((await store.listAccounts()).length, 1);
    } finally {
      deepInfraClient.probeProxy = originalProbe;
      deepInfraClient.models = originalModels;
    }
  });
});

test("createAccounts bounds failed candidate attempts", async () => {
  let checks = 0;
  await withPool(async ({ service }) => {
    await service.importText(Array.from({ length: 10 }, (_, index) => `bad-${index}.local:8080`).join("\n"), "http");
    const originalProbe = deepInfraClient.probeProxy;
    deepInfraClient.probeProxy = async () => { throw new ProxyTransportError("offline"); };
    try {
      const result = await service.createAccounts(1);
      assert.equal(result.accounts.length, 0);
      assert.equal(result.failed.length, 6);
      assert.equal(checks, 6);
    } finally {
      deepInfraClient.probeProxy = originalProbe;
    }
  }, async () => { checks += 1; });
});

test("bulk import accepts more than two thousand lines", async () => {
  await withPool(async ({ service }) => {
    const text = Array.from({ length: 2_501 }, (_, index) => `10.${Math.floor(index / 256)}.${index % 256}.1:${10_000 + index}`).join("\n");
    const result = await service.importText(text, "http");
    assert.equal(result.length, 2_501);
    assert.equal(result.every((entry) => entry.status === "created"), true);
  });
});

test("bulk import keeps valid lines and reports invalid or duplicate lines", async () => {
  await withPool(async ({ service }) => {
    const result = await service.importText([
      "proxy-a.local:8080",
      "invalid",
      "alice:secret@proxy-b.local:1080",
      "proxy-a.local:8080",
    ].join("\n"), "http");
    assert.deepEqual(result.map((item) => item.status), ["created", "invalid", "created", "existing"]);
    assert.equal(result[0]?.source, "http://proxy-a.local:8080");
    assert.equal(result[1]?.source, "Line 2");
    assert.equal(result[2]?.source, "http://al***@proxy-b.local:1080");
  });
});

test("healthy idle candidates precede retry-eligible error proxies", async () => {
  const checked: string[] = [];
  await withPool(async ({ store, service }) => {
    const imported = await service.importText("recovered.local:8080\nidle.local:8080", "http");
    await store.updateProxyPoolHealth(imported[0]!.entry!.id, {
      healthy: false,
      checkedAt: new Date(0).toISOString(),
      error: "old failure",
      retryAfter: 1,
    });
    const account = await store.addAccount({ label: "priority@example.com" });
    const assigned = await service.assignIdle(account.id);
    assert.equal(assigned?.entry?.id, imported[1]?.entry?.id);
    assert.deepEqual(checked, ["http://idle.local:8080/"]);
  }, async (proxy) => { checked.push(proxy); });
});

test("allocation marks failed candidates and binds the next healthy proxy", async () => {
  const checked: string[] = [];
  await withPool(async ({ store, service, notifications }) => {
    await service.importText("bad.local:8080\ngood.local:8080", "http");
    const account = await store.addAccount({ label: "assign@example.com" });
    const assigned = await service.assignIdle(account.id);
    assert.equal(assigned?.account.proxy, "http://good.local:8080/");
    assert.equal(notifications(), 1);
    assert.deepEqual(checked, ["http://bad.local:8080/", "http://good.local:8080/"]);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.find((entry) => entry.maskedUrl.includes("bad.local"))?.status, "error");
    assert.equal(snapshot.find((entry) => entry.maskedUrl.includes("good.local"))?.status, "in_use");
  }, async (proxy) => {
    checked.push(proxy);
    if (proxy.includes("bad.local")) throw new ProxyTransportError("connect failed");
  });
});

test("concurrent rotations reserve distinct proxies", async () => {
  const releases = new Map<string, () => void>();
  await withPool(async ({ store, service }) => {
    await service.importText("one.local:8080\ntwo.local:8080", "http");
    const firstAccount = await store.addAccount({ label: "one@example.com", proxy: "socks5h://initial-one.example:1080" });
    const secondAccount = await store.addAccount({ label: "two@example.com", proxy: "socks5h://initial-two.example:1080" });
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true } });
    const first = service.rotateCustom(firstAccount, new ProxyTransportError("offline"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const checking = await service.snapshot();
    assert.equal(checking.filter((entry) => entry.status === "checking").length, 1);
    const second = service.rotateCustom(secondAccount, new ProxyTransportError("offline"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const release of releases.values()) release();
    const [left, right] = await Promise.all([first, second]);
    assert.ok(left?.entry?.id);
    assert.ok(right?.entry?.id);
    assert.notEqual(left?.entry?.id, right?.entry?.id);
  }, (proxy) => new Promise<void>((resolve) => { releases.set(proxy, resolve); }));
});

test("custom account proxies rotate into the pool and preserve account identity", async () => {
  await withPool(async ({ store, service }) => {
    const [replacement] = await service.importText("replacement.local:8080", "http");
    const account = await store.addAccount({ label: "custom@example.com", proxy: "http://custom.local:8080/" });
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true } });
    const rotated = await service.rotateCustom(account, new ProxyTransportError("offline"));
    assert.equal(rotated?.entry?.id, replacement?.entry?.id);
    assert.equal(rotated?.account.proxyPoolEntryId, replacement?.entry?.id);
    assert.equal(rotated?.account.id, account.id);
  });
});

test("custom account proxies stay bound when rotation is exhausted without direct fallback", async () => {
  await withPool(async ({ store, service }) => {
    const account = await store.addAccount({ label: "custom-empty@example.com", proxy: "http://custom.local:8080/" });
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true, directFallbackWhenExhausted: false } });
    assert.equal(await service.rotateCustom(account, new ProxyTransportError("offline")), undefined);
    assert.equal((await store.getAccount(account.id))?.proxy, "http://custom.local:8080/");
  });
});

test("rotation atomically replaces a failed binding and preserves account identity", async () => {
  await withPool(async ({ store, service }) => {
    const imported = await service.importText("old.local:8080\nnew.local:8080", "http");
    const oldEntry = imported[0]!.entry!;
    const account = await store.addAccount({ label: "rotate@example.com" });
    await store.bindProxyPoolEntry(account.id, oldEntry.id);
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true } });
    const rotated = await service.rotate(account.id, oldEntry.id, new ProxyTransportError("old proxy failed"));
    assert.equal(rotated?.account.proxy, "http://new.local:8080/");
    assert.equal(rotated?.account.id, account.id);
    const oldState = (await service.snapshot()).find((entry) => entry.id === oldEntry.id);
    assert.equal(oldState?.status, "error");
    assert.equal(oldState?.accountId, undefined);
  });
});

test("concurrent rotations converge on the committed replacement", async () => {
  await withPool(async ({ store, service }) => {
    const imported = await service.importText("old.local:8080\nnew.local:8080\nother.local:8080", "http");
    const account = await store.addAccount({ label: "race@example.com" });
    await store.bindProxyPoolEntry(account.id, imported[0]!.entry!.id);
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true } });
    const [left, right] = await Promise.all([
      service.rotate(account.id, imported[0]!.entry!.id, new ProxyTransportError("offline")),
      service.rotate(account.id, imported[0]!.entry!.id, new ProxyTransportError("offline")),
    ]);
    const current = await store.getAccount(account.id);
    assert.ok(current?.proxyPoolEntryId);
    assert.equal(left?.account.proxyPoolEntryId, current?.proxyPoolEntryId);
    assert.equal(right?.account.proxyPoolEntryId, current?.proxyPoolEntryId);
    assert.equal((await service.snapshot()).filter((entry) => entry.accountId === account.id).length, 1);
  });
});

test("delete rejects an entry while its health check is reserved", async () => {
  let release: () => void = () => {};
  await withPool(async ({ service }) => {
    const [imported] = await service.importText("checking.local:8080", "http");
    const checking = service.check(imported!.entry!.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(service.delete(imported!.entry!.id), /being checked/);
    release();
    await checking;
  }, () => new Promise<void>((resolve) => { release = resolve; }));
});

test("rotation keeps failed binding when exhausted unless direct fallback is enabled", async () => {
  await withPool(async ({ store, service }) => {
    const [imported] = await service.importText("only.local:8080", "http");
    const account = await store.addAccount({ label: "fallback@example.com" });
    await store.bindProxyPoolEntry(account.id, imported!.entry!.id);
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true, directFallbackWhenExhausted: false } });
    assert.equal(await service.rotate(account.id, imported!.entry!.id, new ProxyTransportError("offline")), undefined);
    assert.equal((await store.getAccount(account.id))?.proxyPoolEntryId, imported?.entry?.id);

    await store.updateSettings({ proxyPool: { directFallbackWhenExhausted: true } });
    const direct = await service.rotate(account.id, imported!.entry!.id, new ProxyTransportError("offline"));
    assert.equal(direct?.direct, true);
    assert.equal(direct?.account.proxy, undefined);
    assert.equal(direct?.account.id, account.id);
  });
});

test("error proxies recover after manual health check", async () => {
  let healthy = false;
  await withPool(async ({ service }) => {
    const [imported] = await service.importText("recover.local:8080", "http");
    await assert.rejects(service.check(imported!.entry!.id), ProxyTransportError);
    assert.equal((await service.snapshot())[0]?.status, "error");
    healthy = true;
    await service.check(imported!.entry!.id);
    assert.equal((await service.snapshot())[0]?.status, "idle");
  }, async () => {
    if (!healthy) throw new ProxyTransportError("offline");
  });
});
