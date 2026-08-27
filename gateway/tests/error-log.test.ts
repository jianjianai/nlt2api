import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, seedActiveProxy, type Harness } from "~/tests/harness.ts";

function record(h: Harness, overrides: Partial<Parameters<typeof h.errors.record>[0]> = {}) {
  h.errors.record({
    at: h.clock.now,
    kind: "minter",
    status: "failed",
    message: "no_token",
    ...overrides,
  });
}

test("records are listed newest first with filters and pagination", () => {
  const harness = createHarness();
  try {
    record(harness, { kind: "forward", status: "failed", message: "upstream 429", attempt: 1 });
    harness.advance(1_000);
    record(harness, { kind: "minter", status: "failed", message: "page_not_ready" });
    harness.advance(1_000);
    record(harness, { kind: "forward", status: "rejected", message: "capability exhausted" });

    const all = harness.errors.list();
    assert.equal(all.total, 3);
    assert.deepEqual(all.entries.map((entry) => entry.message), ["capability exhausted", "page_not_ready", "upstream 429"]);

    const forward = harness.errors.list({ kind: "forward" });
    assert.equal(forward.total, 2);
    assert.equal(forward.entries[0]?.status, "rejected");
    assert.equal(forward.entries[1]?.attempt, 1);

    const minter = harness.errors.list({ kind: "minter" });
    assert.equal(minter.total, 1);
    assert.equal(minter.entries[0]?.status, "failed");
  } finally {
    harness.close();
  }
});

test("summary groups counts by kind and status", () => {
  const harness = createHarness();
  try {
    record(harness, { kind: "minter", status: "failed" });
    record(harness, { kind: "minter", status: "failed" });
    record(harness, { kind: "minter", status: "rejected" });
    record(harness, { kind: "forward", status: "failed" });
    const summary = harness.errors.summary();
    assert.equal(summary.minter.failed, 2);
    assert.equal(summary.minter.rejected, 1);
    assert.equal(summary.forward.failed, 1);
    assert.equal(summary.forward.rejected, 0);
  } finally {
    harness.close();
  }
});

test("messages are truncated and credentials are never stored", () => {
  const harness = createHarness();
  try {
    record(harness, {
      message: `could not reach http://bobby:secret@1.2.3.4:8080 ${"x".repeat(2_000)}`,
    });
    const entries = harness.errors.list().entries;
    assert.equal(entries.length, 1);
    assert.ok(!entries[0]!.message.includes("secret"));
    assert.ok(entries[0]!.message.length <= 500);
  } finally {
    harness.close();
  }
});

test("session and proxy filters narrow the journal", () => {
  const harness = createHarness();
  try {
    record(harness, { sessionId: "sess-1", proxyId: "prx-1", agentId: "agent-1" });
    record(harness, { sessionId: "sess-2", agentId: "agent-2" });
    record(harness, { proxyId: "prx-1" });

    const bySession = harness.errors.list({ sessionId: "sess-1" });
    assert.equal(bySession.total, 1);
    assert.equal(bySession.entries[0]?.agentId, "agent-1");

    const byProxy = harness.errors.list({ proxyId: "prx-1" });
    assert.equal(byProxy.total, 2);
  } finally {
    harness.close();
  }
});

test("prune drops entries beyond the retention window", () => {
  const harness = createHarness();
  try {
    record(harness, { message: "older" });
    harness.advance(8 * 86_400_000);
    record(harness, { message: "newer" });
    record(harness, { message: "newer too" });
    assert.equal(harness.errors.prune(7), 1);
    const entries = harness.errors.list().entries;
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.message.startsWith("newer")));
  } finally {
    harness.close();
  }
});

test("clear removes everything or only the aged entries", () => {
  const harness = createHarness();
  try {
    record(harness, { message: "old" });
    harness.advance(2 * 86_400_000);
    record(harness, { message: "recent" });
    assert.equal(harness.errors.clear({ olderThanDays: 1 }), 1);
    assert.deepEqual(harness.errors.list().entries.map((entry) => entry.message), ["recent"]);
    assert.equal(harness.errors.clear({ all: true }), 1);
    assert.equal(harness.errors.list().total, 0);
  } finally {
    harness.close();
  }
});

test("proxy failures and rejections stay out of the journal", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    harness.proxies.markFailure(id, "Proxy connection timed out.");
    harness.proxies.markRejected(id, "延迟 800ms 超过 500ms");
    assert.equal(harness.errors.list().total, 0);
  } finally {
    harness.close();
  }
});