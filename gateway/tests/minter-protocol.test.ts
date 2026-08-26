import assert from "node:assert/strict";
import { test } from "node:test";
import { blamesProxy, isMintFailureReason, parseMinterMessage } from "~/server/utils/minter-protocol.ts";

function frame(payload: unknown): string {
  return JSON.stringify(payload);
}

test("hello requires every identity field within bounds", () => {
  const valid = parseMinterMessage(frame({
    type: "hello",
    agentId: "agent-1",
    version: "1.0.0",
    platform: "linux-x64",
    concurrency: 2,
    label: "box-1",
  }));
  assert.deepEqual(valid, {
    type: "hello",
    agentId: "agent-1",
    version: "1.0.0",
    platform: "linux-x64",
    concurrency: 2,
    label: "box-1",
  });

  assert.equal(parseMinterMessage(frame({ type: "hello", agentId: "a", version: "1", platform: "p" })), undefined);
  assert.equal(parseMinterMessage(frame({ type: "hello", agentId: "a", version: "1", platform: "p", concurrency: 0 })), undefined);
  assert.equal(parseMinterMessage(frame({ type: "hello", agentId: "a", version: "1", platform: "p", concurrency: 99 })), undefined);
  assert.equal(parseMinterMessage(frame({ type: "hello", agentId: "x".repeat(65), version: "1", platform: "p", concurrency: 1 })), undefined);
});

test("malformed frames and non-objects are rejected", () => {
  assert.equal(parseMinterMessage("not json"), undefined);
  assert.equal(parseMinterMessage("[]"), undefined);
  assert.equal(parseMinterMessage("null"), undefined);
  assert.equal(parseMinterMessage(frame({ noType: true })), undefined);
});

test("unknown message types are ignored rather than parsed", () => {
  assert.equal(parseMinterMessage(frame({ type: "future.feature", id: "1" })), undefined);
});

test("ticket.submit enforces the token length ceiling", () => {
  const base = { type: "ticket.submit", id: "1", leaseId: "l1", source: "model-embed", mintedAt: 10 };
  assert.ok(parseMinterMessage(frame({ ...base, token: "t".repeat(4_096) })));
  assert.equal(parseMinterMessage(frame({ ...base, token: "t".repeat(4_097) })), undefined);
  assert.equal(parseMinterMessage(frame({ ...base, token: "" })), undefined);
  assert.equal(parseMinterMessage(frame({ ...base, token: "t", mintedAt: -1 })), undefined);
  assert.equal(parseMinterMessage(frame({ ...base, token: "t", mintedAt: 1.5 })), undefined);
});

test("ticket.submit keeps the optional user agent when present", () => {
  const parsed = parseMinterMessage(frame({
    type: "ticket.submit",
    id: "1",
    leaseId: "l1",
    token: "t",
    source: "model-embed",
    mintedAt: 10,
    userAgent: "Mozilla/5.0",
  }));
  assert.equal(parsed?.type === "ticket.submit" ? parsed.userAgent : undefined, "Mozilla/5.0");
});

test("mint.failed only accepts documented reasons", () => {
  assert.ok(parseMinterMessage(frame({ type: "mint.failed", id: "1", reason: "no_token" })));
  assert.equal(parseMinterMessage(frame({ type: "mint.failed", id: "1", reason: "made_up" })), undefined);
  assert.equal(parseMinterMessage(frame({ type: "mint.failed", id: "1" })), undefined);
});

test("only transport reasons blame the proxy", () => {
  for (const reason of ["proxy_connect_failed", "proxy_auth_failed", "proxy_timeout"] as const) {
    assert.equal(blamesProxy(reason), true);
  }
  for (const reason of ["browser_missing", "cdp_socket", "no_token", "challenge_error", "aborted"] as const) {
    assert.equal(blamesProxy(reason), false);
  }
});

test("isMintFailureReason guards arbitrary input", () => {
  assert.equal(isMintFailureReason("cdp_timeout"), true);
  assert.equal(isMintFailureReason("whatever"), false);
  assert.equal(isMintFailureReason(42), false);
});

test("proxy.lease carries an optional renewal hint", () => {
  assert.deepEqual(parseMinterMessage(frame({ type: "proxy.lease", id: "1" })), { type: "proxy.lease", id: "1" });
  assert.deepEqual(
    parseMinterMessage(frame({ type: "proxy.lease", id: "1", preferProxyId: "p1" })),
    { type: "proxy.lease", id: "1", preferProxyId: "p1" },
  );
});

test("lease.release needs only the lease id", () => {
  assert.deepEqual(parseMinterMessage(frame({ type: "lease.release", leaseId: "l1" })), { type: "lease.release", leaseId: "l1" });
  assert.equal(parseMinterMessage(frame({ type: "lease.release" })), undefined);
});
