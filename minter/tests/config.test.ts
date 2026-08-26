import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig, websocketUrl } from "~/src/config.ts";

const REQUIRED = { GATEWAY_URL: "http://gateway:3000", MINTER_TOKEN: "secret" };

test("GATEWAY_URL and MINTER_TOKEN are mandatory", () => {
  assert.throws(() => loadConfig({ MINTER_TOKEN: "secret" }), ConfigError);
  assert.throws(() => loadConfig({ GATEWAY_URL: "http://gateway:3000" }), ConfigError);
  assert.throws(() => loadConfig({ ...REQUIRED, MINTER_TOKEN: "   " }), ConfigError);
});

test("websocketUrl maps the scheme and appends the endpoint path", () => {
  assert.equal(websocketUrl("http://gateway:3000"), "ws://gateway:3000/ws/minter");
  assert.equal(websocketUrl("https://gw.example.com"), "wss://gw.example.com/ws/minter");
  assert.equal(websocketUrl("ws://gateway:3000"), "ws://gateway:3000/ws/minter");
  assert.equal(websocketUrl("wss://gw.example.com/"), "wss://gw.example.com/ws/minter");
});

test("websocketUrl preserves a base path and drops query and hash", () => {
  assert.equal(websocketUrl("http://gateway:3000/api/"), "ws://gateway:3000/api/ws/minter");
  assert.equal(websocketUrl("http://gateway:3000/?a=1#x"), "ws://gateway:3000/ws/minter");
});

test("websocketUrl rejects unusable URLs", () => {
  assert.throws(() => websocketUrl("not a url"), ConfigError);
  assert.throws(() => websocketUrl("ftp://gateway:3000"), ConfigError);
});

test("defaults are applied and numeric bounds are clamped", () => {
  const config = loadConfig(REQUIRED);
  assert.equal(config.concurrency, 1);
  assert.equal(config.basePort, 9_333);
  assert.equal(config.display, ":99");
  assert.equal(config.mintTimeoutMs, 60_000);
  assert.equal(config.idleReleaseMs, 600_000);
  assert.ok(config.agentId.length > 0);
  assert.ok(config.label.length > 0);
  assert.equal(config.browserPath, undefined);

  const clamped = loadConfig({ ...REQUIRED, MINTER_CONCURRENCY: "999", MINTER_MINT_TIMEOUT_MS: "1" });
  assert.equal(clamped.concurrency, 16);
  assert.equal(clamped.mintTimeoutMs, 5_000);

  const nonNumeric = loadConfig({ ...REQUIRED, MINTER_CONCURRENCY: "abc" });
  assert.equal(nonNumeric.concurrency, 1);
});

test("a configured agent id and label win over the hostname default", () => {
  const config = loadConfig({ ...REQUIRED, MINTER_AGENT_ID: "box-1", MINTER_LABEL: "东京节点" });
  assert.equal(config.agentId, "box-1");
  assert.equal(config.label, "东京节点");
});

test("the site key has a default that the gateway can override at runtime", () => {
  assert.equal(loadConfig(REQUIRED).siteKey, "0x4AAAAAADlBNBTRb73O02Vo");
  assert.equal(loadConfig({ ...REQUIRED, MINTER_SITEKEY: "0xOTHER" }).siteKey, "0xOTHER");
});
