import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGatewayMessage, reconnectDelayMs } from "~/src/protocol.ts";

function frame(payload: unknown): string {
  return JSON.stringify(payload);
}

test("welcome requires a session id and a site key", () => {
  const parsed = parseGatewayMessage(frame({
    type: "welcome",
    sessionId: "s1",
    siteKey: "0xKEY",
    serverVersion: "1.0.0",
    heartbeatIntervalMs: 15_000,
    ticketTtlSeconds: 170,
  }));
  assert.deepEqual(parsed, {
    type: "welcome",
    sessionId: "s1",
    siteKey: "0xKEY",
    serverVersion: "1.0.0",
    heartbeatIntervalMs: 15_000,
    ticketTtlSeconds: 170,
  });
  assert.equal(parseGatewayMessage(frame({ type: "welcome", sessionId: "s1" })), undefined);
  assert.equal(parseGatewayMessage(frame({ type: "welcome", siteKey: "0xKEY" })), undefined);
});

test("welcome falls back to defaults for optional numbers", () => {
  const parsed = parseGatewayMessage(frame({ type: "welcome", sessionId: "s1", siteKey: "0xKEY" }));
  assert.equal(parsed?.type === "welcome" ? parsed.heartbeatIntervalMs : 0, 15_000);
  assert.equal(parsed?.type === "welcome" ? parsed.ticketTtlSeconds : 0, 170);
});

test("proxy.leased requires the full lease tuple and a known kind", () => {
  const base = { type: "proxy.leased", id: "1", leaseId: "l1", proxyId: "p1", proxyUrl: "http://1.2.3.4:8080", expiresAt: 10 };
  assert.ok(parseGatewayMessage(frame({ ...base, kind: "http" })));
  assert.equal(parseGatewayMessage(frame({ ...base, kind: "quic" })), undefined);
  assert.equal(parseGatewayMessage(frame({ ...base, kind: "http", proxyUrl: "" })), undefined);
  assert.equal(parseGatewayMessage(frame({ ...base, kind: "http", expiresAt: "soon" })), undefined);
});

test("mint.request floors the count to at least one", () => {
  const parsed = parseGatewayMessage(frame({ type: "mint.request", id: "1", count: 2.7, deadlineMs: 100 }));
  assert.equal(parsed?.type === "mint.request" ? parsed.count : 0, 2);
  const clamped = parseGatewayMessage(frame({ type: "mint.request", id: "1", count: 0, deadlineMs: 100 }));
  assert.equal(clamped?.type === "mint.request" ? clamped.count : 0, 1);
  assert.equal(parseGatewayMessage(frame({ type: "mint.request", id: "1" })), undefined);
});

test("malformed and unknown frames are ignored", () => {
  assert.equal(parseGatewayMessage("not json"), undefined);
  assert.equal(parseGatewayMessage("[]"), undefined);
  assert.equal(parseGatewayMessage(frame({ type: "future.thing", id: "1" })), undefined);
  assert.equal(parseGatewayMessage(frame({ noType: 1 })), undefined);
});

test("ping and pong carry only an id", () => {
  assert.deepEqual(parseGatewayMessage(frame({ type: "ping", id: "p1" })), { type: "ping", id: "p1" });
  assert.deepEqual(parseGatewayMessage(frame({ type: "pong", id: "p1" })), { type: "pong", id: "p1" });
  assert.equal(parseGatewayMessage(frame({ type: "ping" })), undefined);
});

test("reconnect backoff grows exponentially and stops at 30s", () => {
  const noJitter = () => 0.5;
  assert.equal(reconnectDelayMs(1, noJitter), 1_000);
  assert.equal(reconnectDelayMs(2, noJitter), 2_000);
  assert.equal(reconnectDelayMs(5, noJitter), 16_000);
  assert.equal(reconnectDelayMs(6, noJitter), 30_000);
  assert.equal(reconnectDelayMs(50, noJitter), 30_000);
});

test("reconnect backoff stays within the jitter band and above a floor", () => {
  for (const random of [() => 0, () => 1]) {
    const delay = reconnectDelayMs(3, random);
    assert.ok(delay >= 3_200 && delay <= 4_800, `unexpected delay ${delay}`);
  }
  assert.ok(reconnectDelayMs(1, () => 0) >= 500);
});
