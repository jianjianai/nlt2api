import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, seedActiveProxy, type Harness } from "~/tests/harness.ts";

function mint(harness: Harness, token: string, options: { proxyId?: string; mintedAt?: number } = {}): string {
  const lease = harness.proxies.lease("session-a", options.proxyId);
  if ("reason" in lease) throw new Error(`lease failed: ${lease.reason}`);
  const result = harness.tickets.submit({
    sessionId: "session-a",
    leaseId: lease.leaseId,
    token,
    source: "model-embed",
    mintedAt: options.mintedAt ?? harness.clock.now,
    agentId: "agent-1",
  });
  harness.proxies.releaseLease("session-a", lease.leaseId);
  if (!result.ok) throw new Error(`submit rejected: ${result.reason}`);
  return result.ticketId;
}

test("submit requires a live lease owned by the submitting session", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const lease = harness.proxies.lease("session-a");
    assert.ok(!("reason" in lease));
    const wrongSession = harness.tickets.submit({
      sessionId: "session-b",
      leaseId: lease.leaseId,
      token: "t",
      source: "model-embed",
      mintedAt: harness.clock.now,
      agentId: "agent",
    });
    assert.deepEqual(wrongSession, { ok: false, reason: "lease_invalid" });
  } finally {
    harness.close();
  }
});

test("a lease can back only one ticket, so a replayed submit is rejected", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const lease = harness.proxies.lease("session-a");
    assert.ok(!("reason" in lease));
    const submission = {
      sessionId: "session-a",
      leaseId: lease.leaseId,
      token: "t",
      source: "model-embed",
      mintedAt: harness.clock.now,
      agentId: "agent",
    };
    assert.equal(harness.tickets.submit(submission).ok, true);
    harness.proxies.releaseLease("session-a", lease.leaseId);
    assert.deepEqual(harness.tickets.submit(submission), { ok: false, reason: "lease_invalid" });
  } finally {
    harness.close();
  }
});

test("a minter clock running ahead cannot extend a ticket's life", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const ttl = harness.settings.get().ticketTtlSeconds * 1_000;
    const lease = harness.proxies.lease("session-a");
    assert.ok(!("reason" in lease));
    const result = harness.tickets.submit({
      sessionId: "session-a",
      leaseId: lease.leaseId,
      token: "t",
      source: "model-embed",
      mintedAt: harness.clock.now + 60_000,
      agentId: "agent",
    });
    assert.ok(result.ok);
    assert.equal(result.expiresAt, harness.clock.now + ttl);
  } finally {
    harness.close();
  }
});

test("a ticket minted too long ago is rejected instead of entering the pool", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const settings = harness.settings.get();
    const lease = harness.proxies.lease("session-a");
    assert.ok(!("reason" in lease));
    const staleBy = (settings.ticketTtlSeconds - settings.ticketMinRemainingSeconds + 1) * 1_000;
    const result = harness.tickets.submit({
      sessionId: "session-a",
      leaseId: lease.leaseId,
      token: "t",
      source: "model-embed",
      mintedAt: harness.clock.now - staleBy,
      agentId: "agent",
    });
    assert.deepEqual(result, { ok: false, reason: "already_expired" });
  } finally {
    harness.close();
  }
});

test("claim burns the ticket closest to expiry first", () => {
  const harness = createHarness();
  try {
    const proxyA = seedActiveProxy(harness, "http://1.2.3.4:8080");
    const proxyB = seedActiveProxy(harness, "http://5.6.7.8:8080");
    mint(harness, "young", { proxyId: proxyA });
    mint(harness, "old", { proxyId: proxyB, mintedAt: harness.clock.now - 30_000 });

    const first = harness.tickets.claim();
    assert.equal(first?.ticket.token, "old");
    const second = harness.tickets.claim();
    assert.equal(second?.ticket.token, "young");
    assert.equal(harness.tickets.claim(), undefined);
  } finally {
    harness.close();
  }
});

test("claim returns the ticket paired with its own proxy", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness, "http://1.2.3.4:8080");
    mint(harness, "token-1");
    const pair = harness.tickets.claim();
    assert.equal(pair?.proxyUrl, "http://1.2.3.4:8080/");
  } finally {
    harness.close();
  }
});

test("claim skips tickets without enough life left", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    mint(harness, "token-1");
    const settings = harness.settings.get();
    harness.advance((settings.ticketTtlSeconds - settings.ticketMinRemainingSeconds + 1) * 1_000);
    assert.equal(harness.tickets.availableCount(), 0);
    assert.equal(harness.tickets.claim(), undefined);
  } finally {
    harness.close();
  }
});

test("claim skips tickets whose proxy is no longer active", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    mint(harness, "token-1");
    harness.proxies.markFailure(id, "timeout");
    assert.equal(harness.tickets.availableCount(), 0);
    assert.equal(harness.tickets.claim(), undefined);
  } finally {
    harness.close();
  }
});

test("cleanup removes expired tickets and abandoned claims", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    mint(harness, "token-1");
    harness.advance(harness.settings.get().ticketTtlSeconds * 1_000 + 1);
    assert.equal(harness.tickets.cleanup(), 1);
    assert.equal(harness.tickets.totalCount(), 0);

    mint(harness, "token-2");
    harness.tickets.claim();
    harness.advance(5 * 60_000 + 1);
    assert.equal(harness.tickets.cleanup(), 1);
  } finally {
    harness.close();
  }
});

test("snapshot masks tokens and proxy credentials", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness, "http://bobby:secret@1.2.3.4:8080");
    mint(harness, "1.abcdefghijklmnop");
    const [entry] = harness.tickets.snapshot();
    assert.ok(entry);
    assert.equal(entry.maskedToken, "1.abcdef***");
    assert.ok(!entry.maskedProxyUrl.includes("secret"));
    assert.ok(entry.remainingMs > 0);
  } finally {
    harness.close();
  }
});

test("clear empties the pool", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    mint(harness, "token-1");
    assert.equal(harness.tickets.clear(), 1);
    assert.equal(harness.tickets.totalCount(), 0);
  } finally {
    harness.close();
  }
});
