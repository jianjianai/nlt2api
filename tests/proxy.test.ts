import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { HttpError } from "../server/utils/http.ts";
import { maskProxyUrl, normalizeProxyUrl, proxyDispatcher } from "../server/utils/proxy.ts";
import { StateStore } from "../server/utils/state-store.ts";

async function withTempStore<T>(run: (store: StateStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "neuralwatt-proxy-test-"));
  const previous = process.env.NEURALWATT_DATA_DIR;
  process.env.NEURALWATT_DATA_DIR = dir;
  resetProxyConfigForTests();
  try {
    return await run(new StateStore());
  } finally {
    if (previous === undefined) {
      delete process.env.NEURALWATT_DATA_DIR;
    } else {
      process.env.NEURALWATT_DATA_DIR = previous;
    }
    resetProxyConfigForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalizeProxyUrl accepts http and socks proxies with optional auth", () => {
  assert.equal(normalizeProxyUrl("http://proxy.local:8080"), "http://proxy.local:8080/");
  assert.equal(normalizeProxyUrl(" https://user:pass@proxy.local:8443 "), "https://user:pass@proxy.local:8443/");
  assert.equal(normalizeProxyUrl("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
  assert.equal(normalizeProxyUrl("socks5h://user:pass@10.0.0.2:1080"), "socks5h://user:pass@10.0.0.2:1080");
  assert.equal(normalizeProxyUrl("socks4://10.0.0.3:1080"), "socks4://10.0.0.3:1080");
});

test("normalizeProxyUrl rejects unusable proxy URLs", () => {
  for (const value of [
    "",
    "   ",
    "not-a-url",
    "ftp://proxy.local:21",
    "http://:8080",
    "http://proxy.local:8080/path",
    "http://proxy.local:8080?query=1",
    "socks5://proxy.local:99999",
  ]) {
    assert.throws(
      () => normalizeProxyUrl(value),
      (error: unknown) => error instanceof HttpError && error.status === 400 && error.param === "proxy",
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test("maskProxyUrl hides credentials but keeps scheme, host and port", () => {
  assert.equal(maskProxyUrl("http://proxy.local:8080/"), "http://proxy.local:8080");
  assert.equal(maskProxyUrl("socks5://alice:secret@10.0.0.2:1080"), "socks5://al***@10.0.0.2:1080");
  assert.equal(maskProxyUrl("not-a-url"), "***");
});

test("proxyDispatcher returns a cached dispatcher per proxy URL", () => {
  const first = proxyDispatcher("http://proxy.local:8080");
  const second = proxyDispatcher("http://proxy.local:8080");
  const other = proxyDispatcher("socks5://127.0.0.1:1080");
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test("accounts persist, update and clear their proxy", async () => {
  await withTempStore(async (store) => {
    const account = await store.addAccount({
      email: "proxy@example.com",
      password: "secret",
      proxy: "socks5://user:pass@127.0.0.1:1080",
    });
    assert.equal(account.proxy, "socks5://user:pass@127.0.0.1:1080");

    const reloaded = await store.getAccount(account.id);
    assert.equal(reloaded?.proxy, "socks5://user:pass@127.0.0.1:1080");

    const updated = await store.updateAccount(account.id, { proxy: "http://proxy.local:8080" });
    assert.equal(updated.proxy, "http://proxy.local:8080");

    const cleared = await store.updateAccount(account.id, { proxy: null });
    assert.equal(cleared.proxy, undefined);
    assert.equal((await store.getAccount(account.id))?.proxy, undefined);
  });
});

test("accounts without a proxy stay proxy-less", async () => {
  await withTempStore(async (store) => {
    const account = await store.addAccount({ email: "plain@example.com", password: "secret" });
    assert.equal(account.proxy, undefined);
    const updated = await store.updateAccount(account.id, { label: "renamed" });
    assert.equal(updated.proxy, undefined);
  });
});
