import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptiveTarget } from "~/server/utils/demand.ts";
import { HttpError } from "~/server/utils/http.ts";
import { createHarness, seedActiveProxy, type Harness } from "~/tests/harness.ts";

function seedTicket(harness: Harness, token: string, proxyUrl = "http://1.2.3.4:8080"): void {
  const proxyId = harness.proxies.listByStatus("active").find((entry) => entry.url.startsWith(proxyUrl))?.id
    ?? seedActiveProxy(harness, proxyUrl);
  const lease = harness.proxies.lease("session-a", proxyId);
  if ("reason" in lease) throw new Error(lease.reason);
  const result = harness.tickets.submit({
    sessionId: "session-a",
    leaseId: lease.leaseId,
    token,
    source: "model-embed",
    mintedAt: harness.clock.now,
    agentId: "agent",
  });
  harness.proxies.releaseLease("session-a", lease.leaseId);
  if (!result.ok) throw new Error(result.reason);
}

test("adaptiveTarget sizes the pool from the measured rate and the lead time", () => {
  // 60 claims in 120s is 0.5/s; a 60s lead needs 30 standing pairs.
  assert.equal(adaptiveTarget({ claims: 60, windowSeconds: 120, targetLeadSeconds: 60, waiting: 0, minAvailable: 2, maxAvailable: 100, idle: false }), 30);
  // A quiet period never drops below the floor.
  assert.equal(adaptiveTarget({ claims: 0, windowSeconds: 120, targetLeadSeconds: 60, waiting: 0, minAvailable: 2, maxAvailable: 100, idle: false }), 2);
  // The ceiling caps a spike.
  assert.equal(adaptiveTarget({ claims: 6_000, windowSeconds: 120, targetLeadSeconds: 60, waiting: 0, minAvailable: 2, maxAvailable: 40, idle: false }), 40);
  // Queued requests are unmet demand and are added on top of the rate.
  assert.equal(adaptiveTarget({ claims: 0, windowSeconds: 120, targetLeadSeconds: 60, waiting: 5, minAvailable: 2, maxAvailable: 100, idle: false }), 5);
  // Idle means minting is paused entirely.
  assert.equal(adaptiveTarget({ claims: 60, windowSeconds: 120, targetLeadSeconds: 60, waiting: 0, minAvailable: 2, maxAvailable: 100, idle: true }), 0);
  // An inverted band still yields at least the floor.
  assert.equal(adaptiveTarget({ claims: 0, windowSeconds: 120, targetLeadSeconds: 60, waiting: 0, minAvailable: 8, maxAvailable: 4, idle: false }), 8);
});

test("the tracker forgets claims older than its window", () => {
  const harness = createHarness();
  try {
    harness.demand.record();
    harness.demand.record();
    assert.equal(harness.demand.claimsInWindow(), 2);
    harness.advance(harness.settings.get().demandWindowSeconds * 1_000 + 1);
    assert.equal(harness.demand.claimsInWindow(), 0);
  } finally {
    harness.close();
  }
});

test("minting pauses once idle and any request wakes it", () => {
  const harness = createHarness();
  try {
    assert.equal(harness.demand.paused(0), false);
    harness.advance(harness.settings.get().idleAfterSeconds * 1_000 + 1);
    assert.equal(harness.demand.paused(0), true);
    assert.equal(harness.demand.target(0), 0);
    // A waiting request is demand even when the rate window is empty.
    assert.equal(harness.demand.paused(1), false);
    harness.demand.touch();
    assert.equal(harness.demand.paused(0), false);
    assert.equal(harness.demand.target(0), harness.settings.get().minAvailableTickets);
  } finally {
    harness.close();
  }
});

test("idleAfterSeconds of zero keeps the pool warm forever", () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ idleAfterSeconds: 0 });
    harness.advance(30 * 86_400_000);
    assert.equal(harness.demand.paused(0), false);
  } finally {
    harness.close();
  }
});

test("a pair in the pool is handed over without queueing", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.token");
    const pair = await harness.queue.acquire();
    assert.equal(pair.ticket.token, "1.token");
    assert.equal(harness.queue.waiting(), 0);
  } finally {
    harness.close();
  }
});

test("an empty pool parks the request until a ticket is minted", async () => {
  const harness = createHarness();
  try {
    const pending = harness.queue.acquire();
    assert.equal(harness.queue.waiting(), 1);
    seedTicket(harness, "1.late");
    assert.equal(harness.queue.drain(), 1);
    assert.equal((await pending).ticket.token, "1.late");
    assert.equal(harness.queue.waiting(), 0);
  } finally {
    harness.close();
  }
});

test("queued requests are served strictly first-come", async () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness, "http://1.2.3.4:8080");
    seedActiveProxy(harness, "http://5.6.7.8:8080");
    const first = harness.queue.acquire();
    const second = harness.queue.acquire();
    seedTicket(harness, "1.first", "http://1.2.3.4:8080");
    harness.queue.drain();
    seedTicket(harness, "1.second", "http://5.6.7.8:8080");
    harness.queue.drain();
    assert.equal((await first).ticket.token, "1.first");
    assert.equal((await second).ticket.token, "1.second");
  } finally {
    harness.close();
  }
});

test("a ticket that arrives while others wait never jumps the queue", async () => {
  const harness = createHarness();
  try {
    const queued = harness.queue.acquire();
    seedTicket(harness, "1.only");
    // The pool is not empty, but a waiter is ahead: the newcomer must queue too.
    const latecomer = harness.queue.acquire();
    assert.equal(harness.queue.waiting(), 2);
    harness.queue.drain();
    assert.equal((await queued).ticket.token, "1.only");
    harness.queue.rejectAll(new HttpError(503, "done", "server_error"));
    await assert.rejects(() => latecomer, HttpError);
  } finally {
    harness.close();
  }
});

test("the queue rejects once it is full", async () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ queueMaxSize: 1 });
    const queued = harness.queue.acquire();
    await assert.rejects(
      () => harness.queue.acquire(),
      (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "queue_overflow",
    );
    harness.queue.rejectAll(new HttpError(503, "done", "server_error"));
    await assert.rejects(() => queued, HttpError);
  } finally {
    harness.close();
  }
});

test("queueMaxSize of zero reports an empty pool instead of a full queue", async () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ queueMaxSize: 0 });
    await assert.rejects(
      () => harness.queue.acquire(),
      (error: unknown) => error instanceof HttpError && error.code === "ticket_pool_empty",
    );
    assert.equal(harness.queue.waiting(), 0);
  } finally {
    harness.close();
  }
});

test("a disconnected client leaves the queue and consumes no ticket", async () => {
  const harness = createHarness();
  try {
    const controller = new AbortController();
    const pending = harness.queue.acquire(controller.signal);
    assert.equal(harness.queue.waiting(), 1);
    controller.abort();
    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof HttpError && error.status === 499 && error.code === "client_closed_request",
    );
    assert.equal(harness.queue.waiting(), 0);

    // The ticket minted next goes to the pool, not to the abandoned waiter.
    seedTicket(harness, "1.unspent");
    assert.equal(harness.queue.drain(), 0);
    assert.equal(harness.tickets.availableCount(), 1);
  } finally {
    harness.close();
  }
});

test("an already-aborted request is refused before it ever queues", async () => {
  const harness = createHarness();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => harness.queue.acquire(controller.signal),
      (error: unknown) => error instanceof HttpError && error.status === 499,
    );
    assert.equal(harness.queue.waiting(), 0);
  } finally {
    harness.close();
  }
});

test("waiting longer than the timeout fails with queue_timeout", async () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ queueTimeoutSeconds: 1 });
    await assert.rejects(
      () => harness.queue.acquire(),
      (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "queue_timeout",
    );
    assert.equal(harness.queue.waiting(), 0);
  } finally {
    harness.close();
  }
});

test("tryClaim never cuts ahead of a queued request", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.token");
    assert.equal(harness.queue.tryClaim()?.ticket.token, "1.token");
    assert.equal(harness.queue.tryClaim(), undefined);

    const queued = harness.queue.acquire();
    seedTicket(harness, "1.next");
    assert.equal(harness.queue.tryClaim(), undefined);
    harness.queue.drain();
    assert.equal((await queued).ticket.token, "1.next");
  } finally {
    harness.close();
  }
});
