import assert from "node:assert/strict";
import { test } from "node:test";
import { ProxyChecker } from "~/server/utils/proxy-checker.ts";
import { refillDeficit, RefillOrchestrator } from "~/server/utils/refill-orchestrator.ts";
import { MinterHub, type MinterPeer } from "~/server/utils/minter-hub.ts";
import { createHarness, seedActiveProxy, type Harness } from "~/tests/harness.ts";

test("refillDeficit is bounded by both the shortfall and idle proxies", () => {
  assert.equal(refillDeficit({ target: 4, available: 0, inflight: 0, idleActiveProxies: 10 }), 4);
  assert.equal(refillDeficit({ target: 4, available: 0, inflight: 0, idleActiveProxies: 2 }), 2);
  assert.equal(refillDeficit({ target: 4, available: 2, inflight: 2, idleActiveProxies: 10 }), 0);
  assert.equal(refillDeficit({ target: 4, available: 9, inflight: 0, idleActiveProxies: 10 }), 0);
  assert.equal(refillDeficit({ target: 4, available: 0, inflight: 0, idleActiveProxies: 0 }), 0);
  // A paused pool asks for nothing no matter how much capacity is idle.
  assert.equal(refillDeficit({ target: 0, available: 0, inflight: 0, idleActiveProxies: 10 }), 0);
  // Mints already in flight hold (or will hold) a lease, so they consume capacity.
  assert.equal(refillDeficit({ target: 10, available: 0, inflight: 2, idleActiveProxies: 3 }), 1);
  // A pinned request needs a ticket on a specific egress even though the pool
  // as a whole looks full.
  assert.equal(refillDeficit({ target: 4, available: 9, inflight: 0, idleActiveProxies: 10, priorityWanted: 2 }), 2);
  // A paused pool still ignores it: nothing is waiting if nothing is happening.
  assert.equal(refillDeficit({ target: 0, available: 0, inflight: 0, idleActiveProxies: 10, priorityWanted: 3 }), 0);
});

function hubWithPeer(harness: Harness, concurrency = 4): { hub: MinterHub; peer: MinterPeer & { sent: string[] } } {
  const sent: string[] = [];
  const peer: MinterPeer & { sent: string[] } = {
    sent,
    send(data) {
      sent.push(data);
    },
    close() {},
  };
  const hub = new MinterHub({
    db: harness.db,
    settings: harness.settings,
    proxies: harness.proxies,
    tickets: harness.tickets,
    serverVersion: "1.0.0",
    now: () => harness.clock.now,
  });
  hub.open(peer);
  hub.message(peer, JSON.stringify({
    type: "hello",
    agentId: "agent-1",
    version: "1.0.0",
    platform: "linux-x64",
    concurrency,
  }));
  return { hub, peer };
}

test("the orchestrator stays idle when no minter is connected", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const hub = new MinterHub({
      db: harness.db,
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      serverVersion: "1.0.0",
      now: () => harness.clock.now,
    });
    const refill = new RefillOrchestrator({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      hub,
      demand: harness.demand,
      queue: harness.queue,
      mintPriority: harness.mintPriority,
    });
    assert.equal(refill.tick(), 0);
  } finally {
    harness.close();
  }
});

test("a connection that closes stops receiving mint requests", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const { hub, peer } = hubWithPeer(harness, 4);
    const refill = new RefillOrchestrator({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      hub,
      demand: harness.demand,
      queue: harness.queue,
      mintPriority: harness.mintPriority,
    });
    assert.equal(refill.tick(), 1);
    hub.close(peer);
    assert.equal(refill.tick(), 0);
  } finally {
    harness.close();
  }
});

test("the orchestrator asks for the shortfall, capped by idle proxies", () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ minAvailableTickets: 4 });
    seedActiveProxy(harness, "http://1.2.3.4:8080");
    seedActiveProxy(harness, "http://5.6.7.8:8080");
    const { hub } = hubWithPeer(harness, 4);
    const refill = new RefillOrchestrator({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      hub,
      demand: harness.demand,
      queue: harness.queue,
      mintPriority: harness.mintPriority,
    });
    // The floor asks for four but only two proxies are idle.
    assert.equal(refill.tick(), 2);
    assert.equal(hub.inflightTotal(), 2);
    // The inflight count now covers the remaining gap, so a second pass is a no-op.
    assert.equal(refill.tick(), 0);
  } finally {
    harness.close();
  }
});

test("minting pauses after the idle window and resumes on the next request", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const { hub } = hubWithPeer(harness, 4);
    const refill = new RefillOrchestrator({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      hub,
      demand: harness.demand,
      queue: harness.queue,
      mintPriority: harness.mintPriority,
    });
    harness.advance(harness.settings.get().idleAfterSeconds * 1_000 + 1);
    assert.equal(refill.tick(), 0);
    harness.demand.touch();
    assert.equal(refill.tick(), 1);
  } finally {
    harness.close();
  }
});

test("inflight slots are tracked per dispatched mint", () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ mintRequestTimeoutSeconds: 30 });
    seedActiveProxy(harness);
    const { hub } = hubWithPeer(harness, 1);
    assert.equal(hub.dispatchMintRequests(1), 1);
    assert.equal(hub.inflightTotal(), 1);
    // The slot is held until a submit, failure or the reclaim timer fires.
    assert.equal(hub.dispatchMintRequests(1), 0);
  } finally {
    harness.close();
  }
});

test("the checker activates healthy proxies and fails the rest", async () => {
  const harness = createHarness();
  try {
    harness.proxies.import("1.2.3.4:8080\n5.6.7.8:8080", "http");
    const checker = new ProxyChecker({
      settings: harness.settings,
      proxies: harness.proxies,
      probe: async (url) => {
        if (url.includes("1.2.3.4")) return 42;
        throw new Error("Proxy connection was refused.");
      },
    });
    const outcome = await checker.tick();
    assert.equal(outcome.checked, 2);
    assert.equal(outcome.healthy, 1);
    assert.deepEqual(harness.proxies.counts(), { active: 1, pending: 1, unavailable: 0 });
  } finally {
    harness.close();
  }
});

test("the checker skips proxies that are still cooling down", async () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    harness.proxies.markFailure(id, "timeout");
    let probes = 0;
    const checker = new ProxyChecker({
      settings: harness.settings,
      proxies: harness.proxies,
      probe: async () => {
        probes += 1;
        return 10;
      },
    });
    assert.deepEqual(await checker.tick(), { checked: 0, healthy: 0 });
    assert.equal(probes, 0);

    harness.advance(harness.settings.get().proxyRetryCooldownSeconds * 1_000 + 1);
    assert.equal((await checker.tick()).healthy, 1);
    assert.equal(probes, 1);
  } finally {
    harness.close();
  }
});
