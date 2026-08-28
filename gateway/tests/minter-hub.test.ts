import assert from "node:assert/strict";
import { test } from "node:test";
import { MinterHub, type MinterPeer } from "~/server/utils/minter-hub.ts";
import {
  CLOSE_PROTOCOL_VIOLATION,
  CLOSE_REPLACED,
  MAX_PROTOCOL_VIOLATIONS,
} from "~/server/utils/minter-protocol.ts";
import { createHarness, seedActiveProxy, type Harness } from "~/tests/harness.ts";

interface FakePeer extends MinterPeer {
  sent: Array<Record<string, unknown>>;
  closed: Array<{ code?: number; reason?: string }>;
  last(type: string): Record<string, unknown> | undefined;
}

function createPeer(): FakePeer {
  const sent: Array<Record<string, unknown>> = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    sent,
    closed,
    remoteAddress: "203.0.113.7",
    send(data) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    close(code, reason) {
      closed.push({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) });
    },
    last(type) {
      return [...sent].reverse().find((message) => message.type === type);
    },
  };
}

function createHub(harness: Harness): MinterHub {
  return new MinterHub({
    db: harness.db,
    settings: harness.settings,
    proxies: harness.proxies,
    tickets: harness.tickets,
    errors: harness.errors,
    serverVersion: "1.0.0",
    now: () => harness.clock.now,
  });
}

function connect(hub: MinterHub, agentId = "agent-1", concurrency = 2): FakePeer {
  const peer = createPeer();
  hub.open(peer);
  hub.message(peer, JSON.stringify({
    type: "hello",
    agentId,
    version: "1.0.0",
    platform: "linux-x64",
    concurrency,
  }));
  return peer;
}

test("hello is answered with a welcome carrying the site key and TTL", () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const peer = connect(hub);
    const welcome = peer.last("welcome");
    assert.ok(welcome);
    assert.equal(typeof welcome.sessionId, "string");
    assert.equal(welcome.ticketTtlSeconds, harness.settings.get().ticketTtlSeconds);
    assert.equal(typeof welcome.siteKey, "string");
    assert.equal(typeof welcome.stickyMintsMin, "number");
    assert.equal(typeof welcome.stickyMintsMax, "number");
    assert.equal(hub.onlineCount(), 1);
    assert.equal(hub.snapshot()[0]?.remoteAddr, "203.0.113.7");
  } finally {
    harness.close();
  }
});

test("the welcome hands the sticky-minting band down from settings", () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ stickyMintsMin: 2, stickyMintsMax: 5 });
    const hub = createHub(harness);
    const peer = connect(hub);
    const welcome = peer.last("welcome");
    assert.equal(welcome?.stickyMintsMin, 2);
    assert.equal(welcome?.stickyMintsMax, 5);
  } finally {
    harness.close();
  }
});

test("ping is answered with a matching pong", () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const peer = connect(hub);
    hub.message(peer, JSON.stringify({ type: "ping", id: "p1" }));
    assert.deepEqual(peer.last("pong"), { type: "pong", id: "p1" });
  } finally {
    harness.close();
  }
});

test("a reconnect under the same agent id replaces the stale connection", () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const first = connect(hub, "agent-1");
    const second = connect(hub, "agent-1");
    assert.equal(first.closed.at(0)?.code, CLOSE_REPLACED);
    assert.equal(hub.onlineCount(), 1);
    assert.ok(second.last("welcome"));
  } finally {
    harness.close();
  }
});

test("repeated protocol violations close the connection", () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const peer = connect(hub);
    for (let index = 0; index < MAX_PROTOCOL_VIOLATIONS; index += 1) {
      hub.message(peer, "not json");
    }
    assert.equal(peer.closed.at(-1)?.code, CLOSE_PROTOCOL_VIOLATION);
  } finally {
    harness.close();
  }
});

test("the full lease → submit → accept round trip stores a pair", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const hub = createHub(harness);
    const peer = connect(hub);

    hub.message(peer, JSON.stringify({ type: "proxy.lease", id: "l-req" }));
    const leased = peer.last("proxy.leased");
    assert.ok(leased);
    assert.equal(leased.proxyUrl, "http://1.2.3.4:8080/");

    hub.message(peer, JSON.stringify({
      type: "ticket.submit",
      id: "s1",
      leaseId: leased.leaseId,
      token: "1.token",
      source: "model-embed",
      mintedAt: harness.clock.now,
    }));
    assert.ok(peer.last("ticket.accepted"));
    assert.equal(harness.tickets.availableCount(), 1);
    assert.equal(hub.recentRate().minted, 1);
  } finally {
    harness.close();
  }
});

test("no active proxy yields proxy.unavailable rather than a lease", () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const peer = connect(hub);
    hub.message(peer, JSON.stringify({ type: "proxy.lease", id: "l-req" }));
    const reply = peer.last("proxy.unavailable");
    assert.equal(reply?.reason, "no_active_proxy");
  } finally {
    harness.close();
  }
});

test("submitting against another session's lease is rejected", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const hub = createHub(harness);
    const owner = connect(hub, "agent-1");
    const stranger = connect(hub, "agent-2");
    hub.message(owner, JSON.stringify({ type: "proxy.lease", id: "l-req" }));
    const leased = owner.last("proxy.leased");
    assert.ok(leased);

    hub.message(stranger, JSON.stringify({
      type: "ticket.submit",
      id: "s1",
      leaseId: leased.leaseId,
      token: "1.token",
      source: "model-embed",
      mintedAt: harness.clock.now,
    }));
    assert.equal(stranger.last("ticket.rejected")?.reason, "lease_invalid");
    assert.equal(harness.tickets.totalCount(), 0);
  } finally {
    harness.close();
  }
});

test("lease.extend renews, and reports lease.lost once it is gone", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const hub = createHub(harness);
    const peer = connect(hub);
    hub.message(peer, JSON.stringify({ type: "proxy.lease", id: "l-req" }));
    const leased = peer.last("proxy.leased");
    assert.ok(leased);

    harness.advance(1_000);
    hub.message(peer, JSON.stringify({ type: "lease.extend", id: "e1", leaseId: leased.leaseId }));
    assert.ok(Number(peer.last("lease.extended")?.expiresAt) > Number(leased.expiresAt));

    harness.advance(harness.settings.get().proxyLeaseSeconds * 1_000 + 1);
    hub.message(peer, JSON.stringify({ type: "lease.extend", id: "e2", leaseId: leased.leaseId }));
    assert.equal(peer.last("lease.lost")?.reason, "expired");
  } finally {
    harness.close();
  }
});

test("a transport failure blames the proxy; a local failure does not", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    const hub = createHub(harness);
    const peer = connect(hub);

    hub.message(peer, JSON.stringify({ type: "proxy.lease", id: "l1" }));
    hub.message(peer, JSON.stringify({
      type: "mint.failed",
      id: "f1",
      leaseId: peer.last("proxy.leased")?.leaseId,
      reason: "proxy_connect_failed",
    }));
    assert.equal(harness.proxies.require(id).failureCount, 1);

    hub.message(peer, JSON.stringify({ type: "proxy.lease", id: "l2" }));
    const second = peer.last("proxy.leased");
    if (second) {
      hub.message(peer, JSON.stringify({ type: "mint.failed", id: "f2", leaseId: second.leaseId, reason: "no_token" }));
    }
    assert.equal(harness.proxies.require(id).failureCount, 1);
  } finally {
    harness.close();
  }
});

test("failure messages never persist proxy credentials", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness, "http://bobby:secret@1.2.3.4:8080");
    const hub = createHub(harness);
    const peer = connect(hub);
    hub.message(peer, JSON.stringify({
      type: "mint.failed",
      id: "f1",
      reason: "proxy_connect_failed",
      message: "could not reach http://bobby:secret@1.2.3.4:8080",
    }));
    const session = hub.snapshot().at(0);
    assert.ok(session?.lastError);
    assert.ok(!session.lastError.includes("secret"));
    // The journal gets one minter row with the session/agent attached, and the
    // credential stays out of it as well.
    const rows = harness.errors.list({ kind: "minter" }).entries;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sessionId, session.id);
    assert.equal(rows[0]?.agentId, "agent-1");
    assert.ok(!rows[0]!.message.includes("secret"));
  } finally {
    harness.close();
  }
});

test("dispatchMintRequests respects each session's remaining concurrency", () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const peer = connect(hub, "agent-1", 2);
    assert.equal(hub.dispatchMintRequests(5), 2);
    assert.equal(hub.inflightTotal(), 2);
    assert.equal(peer.last("mint.request")?.count, 2);
    assert.equal(hub.dispatchMintRequests(3), 0);
  } finally {
    harness.close();
  }
});

test("an accepted ticket frees one inflight slot", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const hub = createHub(harness);
    const peer = connect(hub, "agent-1", 2);
    hub.dispatchMintRequests(2);
    assert.equal(hub.inflightTotal(), 2);

    hub.message(peer, JSON.stringify({ type: "proxy.lease", id: "l1" }));
    hub.message(peer, JSON.stringify({
      type: "ticket.submit",
      id: "s1",
      leaseId: peer.last("proxy.leased")?.leaseId,
      token: "1.token",
      source: "model-embed",
      mintedAt: harness.clock.now,
    }));
    assert.equal(hub.inflightTotal(), 1);
  } finally {
    harness.close();
  }
});

test("closing a connection releases its leases and marks the session offline", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const hub = createHub(harness);
    const peer = connect(hub);
    hub.message(peer, JSON.stringify({ type: "proxy.lease", id: "l1" }));
    assert.equal(harness.proxies.idleActiveCount(), 0);

    hub.close(peer);
    assert.equal(harness.proxies.idleActiveCount(), 1);
    assert.equal(hub.onlineCount(), 0);
    assert.equal(hub.snapshot().at(0)?.online, false);
  } finally {
    harness.close();
  }
});

test("heartbeat sweeping drops silent connections", () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const peer = connect(hub);
    harness.advance(120_000);
    hub.sweepHeartbeats();
    assert.equal(hub.onlineCount(), 0);
    assert.equal(peer.closed.at(-1)?.reason, "heartbeat_timeout");
  } finally {
    harness.close();
  }
});

test("recoverAfterRestart marks orphaned sessions offline and frees leases", () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness);
    const hub = createHub(harness);
    const peer = connect(hub);
    hub.message(peer, JSON.stringify({ type: "proxy.lease", id: "l1" }));

    const restarted = createHub(harness);
    restarted.recoverAfterRestart();
    assert.equal(harness.proxies.idleActiveCount(), 1);
    assert.equal(restarted.snapshot().every((session) => !session.online), true);
  } finally {
    harness.close();
  }
});

test("disconnectSession kicks an online minter", () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const peer = connect(hub);
    const sessionId = String(peer.last("welcome")?.sessionId);
    assert.equal(hub.disconnectSession(sessionId), true);
    assert.equal(hub.onlineCount(), 0);
    assert.equal(hub.disconnectSession("missing"), false);
  } finally {
    harness.close();
  }
});

test("requestScreenshot forwards the request and resolves with the reply", async () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    const peer = connect(hub);
    const sessionId = String(peer.last("welcome")?.sessionId);

    const promise = hub.requestScreenshot(sessionId, "page");
    assert.equal(peer.last("browser.screenshot.request")?.kind, "page");

    hub.message(peer, JSON.stringify({ type: "browser.screenshot.reply", id: String(peer.last("browser.screenshot.request")?.id), ok: true, pngBase64: "cG5n" }));
    assert.equal(await promise, "cG5n");
  } finally {
    harness.close();
  }
});

test("requestScreenshot rejects for an unknown session", async () => {
  const harness = createHarness();
  try {
    const hub = createHub(harness);
    await assert.rejects(() => hub.requestScreenshot("missing", "page"), /No online authorization service/);
  } finally {
    harness.close();
  }
});
