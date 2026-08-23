import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { HttpError } from "../server/utils/http.ts";
import { maskProxyUrl, normalizeProxyUrl, parseProxyImportLine, proxyDispatcher, proxyDispatcherCacheSize, resetProxyDispatcherCacheForTests } from "../server/utils/proxy.ts";
import { portalResponseBodyTimeoutError } from "../server/utils/portal-client.ts";
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

test("parseProxyImportLine accepts URLs, shorthand authentication and bracketed IPv6", () => {
  assert.deepEqual(parseProxyImportLine("proxy.local:8080", "http"), {
    source: "proxy.local:8080",
    url: "http://proxy.local:8080/",
    kind: "http",
  });
  assert.equal(parseProxyImportLine("proxy.local:1080:user name:p@ss", "socks5").url, "socks5://user%20name:p%40ss@proxy.local:1080");
  assert.equal(parseProxyImportLine("alice:secret@proxy.local:1080", "socks5").url, "socks5://alice:secret@proxy.local:1080");
  assert.equal(parseProxyImportLine("[2001:db8::1]:1080", "socks4").url, "socks4://[2001:db8::1]:1080");
  assert.equal(parseProxyImportLine("socks5h://user:pass@proxy.local:1080", "http").kind, "socks5");
});

test("parseProxyImportLine rejects malformed shorthand", () => {
  for (const value of ["host", "host:nope", "user@host:80", "2001:db8::1:1080", "[2001:db8::1]"]) {
    assert.throws(() => parseProxyImportLine(value, "http"), HttpError);
  }
});

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

test("response body inactivity is classified as an upstream timeout, not proxy transport", () => {
  const error = portalResponseBodyTimeoutError();
  assert.equal(error.status, 504);
  assert.equal(error.name, "PortalError");
});

test("proxyDispatcher cache is bounded and clearable", async () => {
  await resetProxyDispatcherCacheForTests();
  for (let index = 0; index < 140; index += 1) {
    proxyDispatcher(`http://user${index}:pass@proxy-${index}.local:8080`);
  }
  assert.equal(proxyDispatcherCacheSize(), 128);
  await resetProxyDispatcherCacheForTests();
  assert.equal(proxyDispatcherCacheSize(), 0);
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
