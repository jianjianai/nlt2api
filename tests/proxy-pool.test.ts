import deleteProxyHandler from "../server/api/admin/proxies/[id].delete.ts";
import checkProxyHandler from "../server/api/admin/proxies/[id]/check.post.ts";
import assignProxyHandler from "../server/api/admin/accounts/[id]/assign-proxy.post.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { portalClient } from "../server/utils/portal-client.ts";
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
  const dir = await mkdtemp(join(tmpdir(), "neuralwatt-proxy-admin-test-"));
  const previousDir = process.env.NEURALWATT_DATA_DIR;
  const previousToken = process.env.NEURALWATT_ADMIN_TOKEN;
  process.env.NEURALWATT_DATA_DIR = dir;
  process.env.NEURALWATT_ADMIN_TOKEN = "test-admin";
  resetProxyConfigForTests();
  stateStore.resetForTests();
  proxyPoolService.resetForTests();
  try {
    return await run();
  } finally {
    if (previousDir === undefined) delete process.env.NEURALWATT_DATA_DIR;
    else process.env.NEURALWATT_DATA_DIR = previousDir;
    if (previousToken === undefined) delete process.env.NEURALWATT_ADMIN_TOKEN;
    else process.env.NEURALWATT_ADMIN_TOKEN = previousToken;
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
  const dir = await mkdtemp(join(tmpdir(), "neuralwatt-proxy-pool-test-"));
  const previous = process.env.NEURALWATT_DATA_DIR;
  process.env.NEURALWATT_DATA_DIR = dir;
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
    if (previous === undefined) delete process.env.NEURALWATT_DATA_DIR;
    else process.env.NEURALWATT_DATA_DIR = previous;
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
    const boundAccount = await stateStore.addAccount({ email: "bound@example.com", password: "secret" });
    await stateStore.bindProxyPoolEntry(boundAccount.id, pool!.entry.id);
    assert.equal((await deleteHandler(adminEvent(pool!.entry.id))).status, 409);
    assert.equal((await assignHandler(adminEvent(boundAccount.id))).status, 409);

    const [unhealthy] = await stateStore.importProxyPool([{ url: "http://offline.local:8080/", kind: "http" }]);
    const originalCheckProxy = portalClient.checkProxy;
    portalClient.checkProxy = async () => { throw new ProxyTransportError("offline"); };
    try {
      assert.equal((await checkHandler(adminEvent(unhealthy!.entry.id))).status, 502);
    } finally {
      portalClient.checkProxy = originalCheckProxy;
    }
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
    const account = await store.addAccount({ email: "priority@example.com", password: "secret" });
    const assigned = await service.assignIdle(account.id);
    assert.equal(assigned?.entry?.id, imported[1]?.entry?.id);
    assert.deepEqual(checked, ["http://idle.local:8080/"]);
  }, async (proxy) => { checked.push(proxy); });
});

test("allocation marks failed candidates and binds the next healthy proxy", async () => {
  const checked: string[] = [];
  await withPool(async ({ store, service, notifications }) => {
    await service.importText("bad.local:8080\ngood.local:8080", "http");
    const account = await store.addAccount({ email: "assign@example.com", password: "secret" });
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

test("concurrent allocations reserve distinct proxies", async () => {
  const releases = new Map<string, () => void>();
  await withPool(async ({ store, service }) => {
    await service.importText("one.local:8080\ntwo.local:8080", "http");
    const firstAccount = await store.addAccount({ email: "one@example.com", password: "secret" });
    const secondAccount = await store.addAccount({ email: "two@example.com", password: "secret" });
    const first = service.assignIdle(firstAccount.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const checking = await service.snapshot();
    assert.equal(checking.filter((entry) => entry.status === "checking").length, 1);
    const second = service.assignIdle(secondAccount.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const release of releases.values()) release();
    const [left, right] = await Promise.all([first, second]);
    assert.ok(left?.entry?.id);
    assert.ok(right?.entry?.id);
    assert.notEqual(left?.entry?.id, right?.entry?.id);
  }, (proxy) => new Promise<void>((resolve) => { releases.set(proxy, resolve); }));
});

test("custom account proxies rotate into the pool and preserve session", async () => {
  await withPool(async ({ store, service }) => {
    const [replacement] = await service.importText("replacement.local:8080", "http");
    const account = await store.addAccount({ email: "custom@example.com", password: "secret", proxy: "http://custom.local:8080/" });
    await store.updateSession(account.id, { cookie: "nw_session=kept", expiresAt: null, updatedAt: new Date().toISOString() });
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true } });
    const rotated = await service.rotateCustom(account, new ProxyTransportError("offline"));
    assert.equal(rotated?.entry?.id, replacement?.entry?.id);
    assert.equal(rotated?.account.proxyPoolEntryId, replacement?.entry?.id);
    assert.equal(rotated?.account.session?.cookie, "nw_session=kept");
  });
});

test("custom account proxies stay bound when rotation is exhausted without direct fallback", async () => {
  await withPool(async ({ store, service }) => {
    const account = await store.addAccount({ email: "custom-empty@example.com", password: "secret", proxy: "http://custom.local:8080/" });
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true, directFallbackWhenExhausted: false } });
    assert.equal(await service.rotateCustom(account, new ProxyTransportError("offline")), undefined);
    assert.equal((await store.getAccount(account.id))?.proxy, "http://custom.local:8080/");
  });
});

test("rotation atomically replaces a failed binding and preserves session", async () => {
  await withPool(async ({ store, service }) => {
    const imported = await service.importText("old.local:8080\nnew.local:8080", "http");
    const oldEntry = imported[0]!.entry!;
    const account = await store.addAccount({ email: "rotate@example.com", password: "secret" });
    await store.updateSession(account.id, { cookie: "nw_session=kept", expiresAt: null, updatedAt: new Date().toISOString() });
    await store.bindProxyPoolEntry(account.id, oldEntry.id);
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true } });
    const rotated = await service.rotate(account.id, oldEntry.id, new ProxyTransportError("old proxy failed"));
    assert.equal(rotated?.account.proxy, "http://new.local:8080/");
    assert.equal(rotated?.account.session?.cookie, "nw_session=kept");
    const oldState = (await service.snapshot()).find((entry) => entry.id === oldEntry.id);
    assert.equal(oldState?.status, "error");
    assert.equal(oldState?.accountId, undefined);
  });
});

test("concurrent rotations converge on the committed replacement", async () => {
  await withPool(async ({ store, service }) => {
    const imported = await service.importText("old.local:8080\nnew.local:8080\nother.local:8080", "http");
    const account = await store.addAccount({ email: "race@example.com", password: "secret" });
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
    const account = await store.addAccount({ email: "fallback@example.com", password: "secret" });
    await store.updateSession(account.id, { cookie: "nw_session=kept", expiresAt: null, updatedAt: new Date().toISOString() });
    await store.bindProxyPoolEntry(account.id, imported!.entry!.id);
    await store.updateSettings({ proxyPool: { autoRotateOnTransportError: true, directFallbackWhenExhausted: false } });
    assert.equal(await service.rotate(account.id, imported!.entry!.id, new ProxyTransportError("offline")), undefined);
    assert.equal((await store.getAccount(account.id))?.proxyPoolEntryId, imported?.entry?.id);

    await store.updateSettings({ proxyPool: { directFallbackWhenExhausted: true } });
    const direct = await service.rotate(account.id, imported!.entry!.id, new ProxyTransportError("offline"));
    assert.equal(direct?.direct, true);
    assert.equal(direct?.account.proxy, undefined);
    assert.equal(direct?.account.session?.cookie, "nw_session=kept");
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
