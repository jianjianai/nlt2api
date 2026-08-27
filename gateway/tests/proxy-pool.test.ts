import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, seedActiveProxy } from "~/tests/harness.ts";

test("imported proxies start as pending and duplicates are ignored", () => {
  const harness = createHarness();
  try {
    const first = harness.proxies.import("1.2.3.4:8080\n5.6.7.8:8080\n# comment\n\n", "http");
    assert.deepEqual({ imported: first.imported, duplicates: first.duplicates }, { imported: 2, duplicates: 0 });
    assert.deepEqual(harness.proxies.counts(), { active: 0, pending: 2, unavailable: 0 });

    const second = harness.proxies.import("1.2.3.4:8080", "http");
    assert.equal(second.imported, 0);
    assert.equal(second.duplicates, 1);
  } finally {
    harness.close();
  }
});

test("invalid import lines are reported without aborting the batch", () => {
  const harness = createHarness();
  try {
    const summary = harness.proxies.import("1.2.3.4:8080\nnonsense\n5.6.7.8:9090", "http");
    assert.equal(summary.imported, 2);
    assert.equal(summary.invalid.length, 1);
    assert.equal(summary.invalid[0]?.line, "nonsense");
  } finally {
    harness.close();
  }
});

test("a healthy probe activates the proxy and clears failures", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness, "http://1.2.3.4:8080", 42);
    const record = harness.proxies.require(id);
    assert.equal(record.status, "active");
    assert.equal(record.failureCount, 0);
    assert.equal(record.latencyMs, 42);
    assert.equal(record.retryAfter, undefined);
  } finally {
    harness.close();
  }
});

test("failures cool down as pending until the threshold flips to unavailable", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    const threshold = harness.settings.get().proxyFailureThreshold;
    for (let attempt = 1; attempt < threshold; attempt += 1) {
      assert.equal(harness.proxies.markFailure(id, "timeout"), "pending");
      const record = harness.proxies.require(id);
      assert.equal(record.failureCount, attempt);
      assert.ok(record.retryAfter && record.retryAfter > harness.clock.now);
    }
    assert.equal(harness.proxies.markFailure(id, "timeout"), "unavailable");
    assert.equal(harness.proxies.require(id).retryAfter, undefined);
  } finally {
    harness.close();
  }
});

test("dueForCheck respects the cooldown window", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    harness.proxies.markFailure(id, "timeout");
    assert.equal(harness.proxies.dueForCheck(10).length, 0);
    harness.advance(harness.settings.get().proxyRetryCooldownSeconds * 1_000 + 1);
    assert.equal(harness.proxies.dueForCheck(10).length, 1);
  } finally {
    harness.close();
  }
});

test("reactivate clears the unavailable state and re-queues a probe", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    for (let attempt = 0; attempt < harness.settings.get().proxyFailureThreshold; attempt += 1) {
      harness.proxies.markFailure(id, "timeout");
    }
    assert.equal(harness.proxies.require(id).status, "unavailable");
    harness.proxies.reactivate(id);
    const record = harness.proxies.require(id);
    assert.equal(record.status, "pending");
    assert.equal(record.failureCount, 0);
    assert.equal(harness.proxies.dueForCheck(10).length, 1);
  } finally {
    harness.close();
  }
});

test("a lease is exclusive: a second session gets all_leased", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const first = harness.proxies.lease("session-a");
    assert.ok(!("reason" in first));
    const second = harness.proxies.lease("session-b");
    assert.deepEqual(second, { reason: "all_leased" });
  } finally {
    harness.close();
  }
});

test("an expired lease becomes available again", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const first = harness.proxies.lease("session-a");
    assert.ok(!("reason" in first));
    harness.advance(harness.settings.get().proxyLeaseSeconds * 1_000 + 1);
    const second = harness.proxies.lease("session-b");
    assert.ok(!("reason" in second));
  } finally {
    harness.close();
  }
});

test("preferProxyId renews the same proxy only while that is still the fair choice", () => {
  const harness = createHarness();
  try {
    const first = seedActiveProxy(harness, "http://1.2.3.4:8080");
    const second = seedActiveProxy(harness, "http://5.6.7.8:8080");
    const initial = harness.proxies.lease("session-a");
    assert.ok(!("reason" in initial));
    harness.proxies.releaseLease("session-a", initial.leaseId);

    // The other egress has never minted, so fairness sends the worker there even
    // though it asked to keep its current proxy.
    const rotated = harness.proxies.lease("session-a", initial.proxyId);
    assert.ok(!("reason" in rotated));
    assert.notEqual(rotated.proxyId, initial.proxyId);
    harness.proxies.releaseLease("session-a", rotated.leaseId);

    // Both have now minted equally recently, so the preference is honoured and
    // the browser does not have to restart just to change --proxy-server.
    harness.advance(1_000);
    const renewed = harness.proxies.lease("session-a", rotated.proxyId);
    assert.ok(!("reason" in renewed));
    assert.equal(renewed.proxyId, rotated.proxyId);
    assert.deepEqual([first, second].sort(), [initial.proxyId, rotated.proxyId].sort());
  } finally {
    harness.close();
  }
});

test("lease spreads mints over egresses before weighing ticket counts", () => {
  const harness = createHarness();
  try {
    const loaded = seedActiveProxy(harness, "http://1.2.3.4:8080");
    const empty = seedActiveProxy(harness, "http://5.6.7.8:8080");
    const lease = harness.proxies.lease("session-a", loaded);
    assert.ok(!("reason" in lease));
    harness.tickets.submit({
      sessionId: "session-a",
      leaseId: lease.leaseId,
      token: "t1",
      source: "model-embed",
      mintedAt: harness.clock.now,
      agentId: "agent",
    });
    harness.proxies.releaseLease("session-a", lease.leaseId);

    // `loaded` just minted, so the untouched egress is next regardless of tickets.
    const next = harness.proxies.lease("session-b");
    assert.ok(!("reason" in next));
    assert.equal(next.proxyId, empty);
    harness.proxies.releaseLease("session-b", next.leaseId);

    // With mint recency equal, the egress holding fewer live tickets wins.
    harness.proxies.markMinted(loaded, harness.clock.now);
    harness.proxies.markMinted(empty, harness.clock.now);
    const tiebreak = harness.proxies.lease("session-c");
    assert.ok(!("reason" in tiebreak));
    assert.equal(tiebreak.proxyId, empty);
  } finally {
    harness.close();
  }
});

test("authenticated SOCKS proxies are never leased for minting", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness, "socks5://bob:secret@1.2.3.4:1080");
    assert.deepEqual(harness.proxies.lease("session-a"), { reason: "no_active_proxy" });
  } finally {
    harness.close();
  }
});

test("extendLease pushes the deadline, and fails once the lease is gone", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const lease = harness.proxies.lease("session-a");
    assert.ok(!("reason" in lease));
    harness.advance(1_000);
    const extended = harness.proxies.extendLease("session-a", lease.leaseId);
    assert.ok(extended && extended > lease.expiresAt);
    harness.proxies.releaseLease("session-a", lease.leaseId);
    assert.equal(harness.proxies.extendLease("session-a", lease.leaseId), undefined);
  } finally {
    harness.close();
  }
});

test("releaseSessionLeases and resetLeases free every held proxy", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness, "http://1.2.3.4:8080");
    seedActiveProxy(harness, "http://5.6.7.8:8080");
    harness.proxies.lease("session-a");
    harness.proxies.lease("session-a");
    assert.equal(harness.proxies.idleActiveCount(), 0);
    harness.proxies.releaseSessionLeases("session-a");
    assert.equal(harness.proxies.idleActiveCount(), 2);

    harness.proxies.lease("session-b");
    harness.proxies.resetLeases();
    assert.equal(harness.proxies.idleActiveCount(), 2);
  } finally {
    harness.close();
  }
});

test("snapshot masks credentials and reports mintability", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness, "http://bobby:secret@1.2.3.4:8080");
    seedActiveProxy(harness, "socks5://bob:secret@5.6.7.8:1080");
    const { entries, total } = harness.proxies.snapshot({ limit: 50 });
    assert.equal(total, 2);
    for (const entry of entries) {
      assert.ok(!entry.maskedUrl.includes("secret"));
    }
    assert.equal(entries.find((entry) => entry.kind === "http")?.mintable, true);
    assert.equal(entries.find((entry) => entry.kind === "socks5")?.mintable, false);
  } finally {
    harness.close();
  }
});

test("deleting a proxy cascades its tickets", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    const lease = harness.proxies.lease("session-a");
    assert.ok(!("reason" in lease));
    harness.tickets.submit({
      sessionId: "session-a",
      leaseId: lease.leaseId,
      token: "token",
      source: "model-embed",
      mintedAt: harness.clock.now,
      agentId: "agent",
    });
    assert.equal(harness.tickets.totalCount(), 1);
    assert.equal(harness.proxies.delete(id), true);
    assert.equal(harness.tickets.totalCount(), 0);
  } finally {
    harness.close();
  }
});
