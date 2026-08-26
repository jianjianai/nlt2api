import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserProxyTarget,
  canonicalProxy,
  isMintableProxy,
  maskProxyUrl,
  normalizeProxyUrl,
  parseProxyImportLine,
  redactProxyUrls,
} from "~/server/utils/proxy.ts";
import { HttpError } from "~/server/utils/http.ts";

test("canonicalProxy maps protocol aliases onto the stored kind", () => {
  assert.equal(canonicalProxy("http://1.2.3.4:8080").kind, "http");
  assert.equal(canonicalProxy("https://1.2.3.4:8443").kind, "http");
  assert.equal(canonicalProxy("socks://1.2.3.4:1080").kind, "socks5");
  assert.equal(canonicalProxy("socks5h://1.2.3.4:1080").kind, "socks5");
  assert.equal(canonicalProxy("socks4a://1.2.3.4:1080").kind, "socks4");
});

test("canonicalProxy rejects unusable URLs", () => {
  assert.throws(() => canonicalProxy(""), HttpError);
  assert.throws(() => canonicalProxy("ftp://1.2.3.4:21"), HttpError);
  assert.throws(() => canonicalProxy("http://1.2.3.4:8080/path"), HttpError);
  assert.throws(() => canonicalProxy("http://1.2.3.4:8080?a=1"), HttpError);
  assert.throws(() => canonicalProxy("not a url"), HttpError);
});

test("parseProxyImportLine accepts every documented shorthand", () => {
  assert.equal(parseProxyImportLine("1.2.3.4:8080", "http").url, "http://1.2.3.4:8080/");
  // socks5 is not a special scheme, so WHATWG URL keeps it path-less.
  assert.equal(parseProxyImportLine("1.2.3.4:1080", "socks5").url, "socks5://1.2.3.4:1080");
  assert.equal(parseProxyImportLine("1.2.3.4:8080:bob:secret", "http").url, "http://bob:secret@1.2.3.4:8080/");
  assert.equal(parseProxyImportLine("bob:secret@1.2.3.4:8080", "http").url, "http://bob:secret@1.2.3.4:8080/");
  assert.equal(parseProxyImportLine("[2001:db8::1]:8080", "http").url, "http://[2001:db8::1]:8080/");
  assert.equal(parseProxyImportLine("socks5://1.2.3.4:1080", "http").kind, "socks5");
});

test("parseProxyImportLine rejects malformed ports and empty lines", () => {
  assert.throws(() => parseProxyImportLine("1.2.3.4:0", "http"), HttpError);
  assert.throws(() => parseProxyImportLine("1.2.3.4:70000", "http"), HttpError);
  assert.throws(() => parseProxyImportLine("", "http"), HttpError);
  assert.throws(() => parseProxyImportLine("1.2.3.4", "http"), HttpError);
});

test("maskProxyUrl keeps only the first two username characters", () => {
  assert.equal(maskProxyUrl("http://bobby:secret@1.2.3.4:8080"), "http://bo***@1.2.3.4:8080");
  assert.equal(maskProxyUrl("http://1.2.3.4:8080"), "http://1.2.3.4:8080");
  assert.equal(maskProxyUrl("garbage"), "***");
});

test("redactProxyUrls strips credentials from free-form text", () => {
  assert.equal(
    redactProxyUrls("connect failed for http://bobby:secret@1.2.3.4:8080 after 3 tries"),
    "connect failed for http://bo***@1.2.3.4:8080 after 3 tries",
  );
  assert.equal(redactProxyUrls("plain message"), "plain message");
});

test("browserProxyTarget never embeds credentials in --proxy-server", () => {
  const target = browserProxyTarget("http://bob:secret@1.2.3.4:8080");
  assert.deepEqual(target, { server: "http://1.2.3.4:8080", username: "bob", password: "secret" });
});

test("browserProxyTarget defaults the port per scheme", () => {
  assert.equal(browserProxyTarget("http://1.2.3.4")?.server, "http://1.2.3.4:80");
  assert.equal(browserProxyTarget("socks5://1.2.3.4")?.server, "socks5://1.2.3.4:1080");
});

test("authenticated SOCKS proxies cannot drive a browser", () => {
  // Chrome has no CDP path to answer SOCKS auth, so such a proxy is unmintable.
  assert.equal(browserProxyTarget("socks5://bob:secret@1.2.3.4:1080"), undefined);
  assert.equal(isMintableProxy("socks5://bob:secret@1.2.3.4:1080"), false);
  assert.equal(isMintableProxy("socks5://1.2.3.4:1080"), true);
  assert.equal(isMintableProxy("http://bob:secret@1.2.3.4:8080"), true);
  assert.equal(isMintableProxy("garbage"), false);
});

test("normalizeProxyUrl is idempotent", () => {
  const once = normalizeProxyUrl("HTTP://1.2.3.4:8080");
  assert.equal(normalizeProxyUrl(once), once);
});
