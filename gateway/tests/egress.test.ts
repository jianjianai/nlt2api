import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationKey, sessionIdFromHeaders } from "~/server/utils/affinity.ts";
import { ForwardService } from "~/server/utils/forward-service.ts";
import { UpstreamError } from "~/server/utils/upstream-http.ts";
import { upstreamErrorFrom } from "~/server/utils/upstream.ts";
import type { JsonObject } from "~/server/utils/types.ts";
import { createHarness, seedActiveProxy, type Harness } from "~/tests/harness.ts";

function seedTicket(harness: Harness, token: string, proxyUrl: string): string {
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
  return proxyId;
}

function turn(content: string, ...rest: string[]): JsonObject {
  return {
    model: "m",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content },
      ...rest.map((text, index) => (index % 2 === 0 ? { role: "assistant", content: text } : { role: "user", content: text })),
    ],
  };
}

test("a conversation keeps its key as turns are appended", () => {
  const first = conversationKey(turn("hello"));
  const second = conversationKey(turn("hello", "hi there", "and then?"));
  assert.ok(first);
  assert.equal(first, second);
  // A different opening is a different conversation.
  assert.notEqual(first, conversationKey(turn("something else")));
  // The same opening from a distinct caller must not collide.
  assert.notEqual(first, conversationKey({ ...turn("hello"), user: "bob" }));
  assert.equal(conversationKey({ model: "m", messages: [] }), undefined);
  assert.equal(conversationKey({ model: "m" }), undefined);
});

test("an explicit session id takes precedence over the message head", () => {
  const pinned = conversationKey(turn("hello"), "sess-1");
  assert.ok(pinned);
  // The same id keys the same conversation even when the history diverges.
  assert.equal(pinned, conversationKey(turn("completely different"), "sess-1"));
  // A different id is a different conversation despite an identical history.
  assert.notEqual(pinned, conversationKey(turn("hello"), "sess-2"));
  // The head-derived key must not collide with an id-derived one.
  assert.notEqual(pinned, conversationKey(turn("hello")));
  // Two callers cannot share a pin by reusing an id.
  assert.notEqual(pinned, conversationKey({ ...turn("hello"), user: "bob" }, "sess-1"));
  // An id is enough on its own; no messages are needed.
  assert.ok(conversationKey({ model: "m" }, "sess-1"));
});

test("a session id in the body works when headers are unavailable", () => {
  const fromHeader = conversationKey(turn("hello"), "sess-1");
  assert.equal(conversationKey({ ...turn("hello"), session_id: "sess-1" }), fromHeader);
  assert.equal(conversationKey({ ...turn("hello"), conversation_id: "sess-1" }), fromHeader);
  assert.equal(conversationKey({ ...turn("hello"), metadata: { chat_id: "sess-1" } }), fromHeader);
  // The header wins over a body field so a proxy cannot be overridden by payload.
  assert.equal(conversationKey({ ...turn("hello"), session_id: "sess-2" }, "sess-1"), fromHeader);
});

test("unusable session ids fall back to the message head", () => {
  const head = conversationKey(turn("hello"));
  assert.equal(conversationKey(turn("hello"), "   "), head);
  assert.equal(conversationKey(turn("hello"), "x".repeat(201)), head);
  assert.equal(conversationKey({ ...turn("hello"), session_id: 42 as never }), head);
});

test("session ids are read from the accepted headers only", () => {
  assert.equal(sessionIdFromHeaders(new Headers({ "x-session-id": " sess-1 " })), "sess-1");
  assert.equal(sessionIdFromHeaders(new Headers({ "x-conversation-id": "sess-2" })), "sess-2");
  assert.equal(sessionIdFromHeaders(new Headers({ "x-chat-id": "sess-3" })), "sess-3");
  // x-session-id is preferred when several are present.
  assert.equal(sessionIdFromHeaders(new Headers({ "x-chat-id": "sess-3", "x-session-id": "sess-1" })), "sess-1");
  assert.equal(sessionIdFromHeaders(new Headers({ "x-other": "sess-1" })), undefined);
  assert.equal(sessionIdFromHeaders(new Headers()), undefined);
});

test("affinity expires and can be disabled outright", () => {
  const harness = createHarness();
  try {
    harness.affinity.remember("key", "proxy-1");
    assert.equal(harness.affinity.resolve("key"), "proxy-1");
    harness.advance(harness.settings.get().affinityTtlSeconds * 1_000 + 1);
    assert.equal(harness.affinity.resolve("key"), undefined);
    assert.equal(harness.affinity.size(), 0);

    harness.settings.patch({ affinityTtlSeconds: 0 });
    harness.affinity.remember("key", "proxy-1");
    assert.equal(harness.affinity.resolve("key"), undefined);
    assert.equal(harness.affinity.size(), 0);
  } finally {
    harness.close();
  }
});

test("a new conversation takes the egress that has been idle longest", () => {
  const harness = createHarness();
  try {
    const first = seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    const second = seedTicket(harness, "1.b", "http://2.2.2.2:8080");
    // Stamp one egress as just used; rotation must then prefer the other.
    harness.proxies.markUsed(first);
    harness.advance(1_000);
    assert.equal(harness.tickets.claim()?.ticket.proxyId, second);
    // Claiming stamps the winner too, so the next one swings back.
    seedTicket(harness, "1.c", "http://2.2.2.2:8080");
    harness.advance(1_000);
    assert.equal(harness.tickets.claim()?.ticket.proxyId, first);
  } finally {
    harness.close();
  }
});

test("a claim honours the preferred egress and falls back when it is dry", () => {
  const harness = createHarness();
  try {
    const first = seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    const second = seedTicket(harness, "1.b", "http://2.2.2.2:8080");
    // The preference wins even though the other egress is the rotation choice.
    harness.proxies.markUsed(second);
    assert.equal(harness.tickets.claim(second)?.ticket.proxyId, second);
    // That egress is now dry, so the preference is dropped rather than stalling.
    assert.equal(harness.tickets.claim(second)?.ticket.proxyId, first);
  } finally {
    harness.close();
  }
});

test("a rate-limited egress is excluded from claims and counts", () => {
  const harness = createHarness();
  try {
    const limited = seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    seedTicket(harness, "1.b", "http://2.2.2.2:8080");
    harness.proxies.markCooldown(limited, 60_000, "rate_limit");

    assert.equal(harness.tickets.availableCount(), 1);
    assert.equal(harness.proxies.rateLimitedCount(), 1);
    assert.equal(harness.proxies.cooldownCount("rate_limit"), 1);
    assert.equal(harness.proxies.cooldownCount("ip_blocked"), 0);
    assert.equal(harness.proxies.forwardableActiveCount(), 1);
    // Even an explicit preference cannot route to a parked egress.
    assert.notEqual(harness.tickets.claim(limited)?.ticket.proxyId, limited);
    // A strict pin on a parked egress yields nothing rather than another IP.
    assert.equal(harness.tickets.claim(limited, true), undefined);

    harness.advance(60_001);
    assert.equal(harness.proxies.rateLimitedCount(), 0);
    assert.equal(harness.proxies.forwardableActiveCount(), 2);
  } finally {
    harness.close();
  }
});

test("a parked egress is not leased for minting", () => {
  const harness = createHarness();
  try {
    const only = seedActiveProxy(harness, "http://1.1.1.1:8080");
    harness.proxies.markCooldown(only, 60_000, "rate_limit");
    assert.deepEqual(harness.proxies.lease("session-b"), { reason: "all_leased" });
    assert.equal(harness.proxies.idleActiveCount(), 0);

    harness.advance(60_001);
    assert.ok("leaseId" in harness.proxies.lease("session-b"));
  } finally {
    harness.close();
  }
});

test("markCooldown never shortens an existing cooldown", () => {
  const harness = createHarness();
  try {
    const id = seedActiveProxy(harness);
    harness.proxies.markCooldown(id, 120_000, "ip_blocked");
    harness.proxies.markCooldown(id, 5_000, "rate_limit");
    const record = harness.proxies.require(id);
    assert.equal(record.rateLimitedUntil, harness.clock.now + 120_000);
    // The longer window keeps its reason too, so the console does not downgrade it.
    assert.equal(record.cooldownReason, "ip_blocked");
  } finally {
    harness.close();
  }
});

test("a 429 parks that egress and the retry lands on another one", async () => {
  const harness = createHarness();
  try {
    const first = seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    const second = seedTicket(harness, "1.b", "http://2.2.2.2:8080");
    const seen: string[] = [];
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async (options) => {
        seen.push(options.ticket.proxyId);
        if (seen.length === 1) throw upstreamErrorFrom(429, JSON.stringify({ error: { message: "slow down" }, retry_after: 30 }));
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal((await forward.chat(turn("hello"))).status, 200);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
    // The upstream Retry-After drives the cooldown for the offending egress only.
    assert.equal(harness.proxies.require(seen[0]!).rateLimitedUntil, harness.clock.now + 30_000);
    assert.equal(harness.proxies.require(seen[1]!).rateLimitedUntil, undefined);
    assert.deepEqual([first, second].sort(), [...seen].sort());
  } finally {
    harness.close();
  }
});

test("a continuation reuses the egress its first turn was served from", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    seedTicket(harness, "1.b", "http://2.2.2.2:8080");
    const seen: string[] = [];
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async (options) => {
        seen.push(options.ticket.proxyId);
        return new Response("{}", { status: 200 });
      },
    });
    await forward.chat(turn("hello"));
    const pinned = seen[0]!;
    // Refill both egresses and stamp the pinned one as just used, so rotation
    // would pick the other: only affinity can explain reusing it.
    seedTicket(harness, "1.c", "http://1.1.1.1:8080");
    seedTicket(harness, "1.d", "http://2.2.2.2:8080");
    harness.proxies.markUsed(pinned);
    harness.advance(1_000);
    await forward.chat(turn("hello", "hi", "and then?"));
    assert.equal(seen[1], pinned);
  } finally {
    harness.close();
  }
});

test("a session id pins the egress even when the history changes", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    seedTicket(harness, "1.b", "http://2.2.2.2:8080");
    const seen: string[] = [];
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async (options) => {
        seen.push(options.ticket.proxyId);
        return new Response("{}", { status: 200 });
      },
    });
    await forward.chat(turn("hello"), undefined, "sess-1");
    const pinned = seen[0]!;
    seedTicket(harness, "1.c", "http://1.1.1.1:8080");
    seedTicket(harness, "1.d", "http://2.2.2.2:8080");
    harness.proxies.markUsed(pinned);
    harness.advance(1_000);
    // A trimmed history would break head-based keying; the id still pins it.
    await forward.chat(turn("a totally different opening"), undefined, "sess-1");
    assert.equal(seen[1], pinned);
  } finally {
    harness.close();
  }
});

test("a rate limit on the pinned egress drops the pin", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    seedTicket(harness, "1.b", "http://2.2.2.2:8080");
    const request = turn("hello");
    const key = conversationKey(request);
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async () => {
        throw upstreamErrorFrom(429, "{}");
      },
    });
    await assert.rejects(() => forward.chat(request), UpstreamError);
    assert.equal(harness.affinity.resolve(key), undefined);
    // Both egresses were tried and both are parked with the fallback cooldown.
    assert.equal(harness.proxies.cooldownCount("rate_limit"), 2);
  } finally {
    harness.close();
  }
});

test("a 403 parks the egress far longer than a 429 does", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    seedTicket(harness, "1.b", "http://2.2.2.2:8080");
    const settings = harness.settings.get();
    const seen: string[] = [];
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async (options) => {
        seen.push(options.ticket.proxyId);
        // The upstream refusing the egress itself, not the ticket.
        if (seen.length === 1) throw upstreamErrorFrom(403, JSON.stringify({ error: { message: "Not authenticated" } }));
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal((await forward.chat(turn("hello"))).status, 200);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
    const blocked = harness.proxies.require(seen[0]!);
    assert.equal(blocked.cooldownReason, "ip_blocked");
    assert.equal(blocked.rateLimitedUntil, harness.clock.now + settings.ipBlockCooldownSeconds * 1_000);
    assert.ok(settings.ipBlockCooldownSeconds > settings.rateLimitCooldownSeconds);
    assert.equal(harness.proxies.cooldownCount("ip_blocked"), 1);
  } finally {
    harness.close();
  }
});

test("a 403 ignores a short Retry-After: the IP itself is refused", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.a", "http://1.1.1.1:8080");
    const settings = harness.settings.get();
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async () => {
        throw upstreamErrorFrom(403, JSON.stringify({ error: { message: "Not authenticated", retry_after: 2 } }));
      },
    });
    await assert.rejects(() => forward.chat(turn("hello")), UpstreamError);
    const only = harness.proxies.listByStatus("active")[0]!;
    assert.equal(harness.proxies.require(only.id).rateLimitedUntil, harness.clock.now + settings.ipBlockCooldownSeconds * 1_000);
  } finally {
    harness.close();
  }
});

test("a pinned request waits for its own egress and asks for a mint there", async () => {
  const harness = createHarness();
  try {
    const pinned = seedActiveProxy(harness, "http://1.1.1.1:8080");
    seedTicket(harness, "1.other", "http://2.2.2.2:8080");

    const pending = harness.queue.acquire(undefined, pinned);
    // A ticket exists, but not on the pinned egress: the request queues instead
    // of silently moving the conversation to another IP.
    assert.equal(harness.queue.waiting(), 1);
    assert.deepEqual(harness.mintPriority.ids(), [pinned]);

    seedTicket(harness, "1.pinned", "http://1.1.1.1:8080");
    assert.equal(harness.queue.drain(), 1);
    assert.equal((await pending).ticket.proxyId, pinned);
    // Serving it clears the priority so the pool stops over-minting there.
    assert.deepEqual(harness.mintPriority.ids(), []);
  } finally {
    harness.close();
  }
});

test("the pin relaxes after affinityWaitSeconds so a slow mint cannot stall the request", async () => {
  const harness = createHarness();
  try {
    const pinned = seedActiveProxy(harness, "http://1.1.1.1:8080");
    const other = seedTicket(harness, "1.other", "http://2.2.2.2:8080");
    const pending = harness.queue.acquire(undefined, pinned);
    assert.equal(harness.queue.waiting(), 1);
    // Still strict: the other egress's ticket is not acceptable yet.
    assert.equal(harness.queue.drain(), 0);

    harness.advance(harness.settings.get().affinityWaitSeconds * 1_000 + 1);
    assert.equal(harness.queue.drain(), 1);
    assert.equal((await pending).ticket.proxyId, other);
  } finally {
    harness.close();
  }
});

test("a strict waiter does not block the queue behind it", async () => {
  const harness = createHarness();
  try {
    const pinned = seedActiveProxy(harness, "http://1.1.1.1:8080");
    const other = seedTicket(harness, "1.other", "http://2.2.2.2:8080");
    const strict = harness.queue.acquire(undefined, pinned);
    const behind = harness.queue.acquire();
    assert.equal(harness.queue.waiting(), 2);

    // The head is pinned to an egress with no ticket; the one behind it is not
    // and must still be served rather than waiting on someone else's mint.
    assert.equal(harness.queue.drain(), 1);
    assert.equal((await behind).ticket.proxyId, other);
    assert.equal(harness.queue.waiting(), 1);

    seedTicket(harness, "1.pinned", "http://1.1.1.1:8080");
    harness.queue.drain();
    assert.equal((await strict).ticket.proxyId, pinned);
  } finally {
    harness.close();
  }
});

test("the refill loop sees the egress a pinned request is waiting on", async () => {
  const harness = createHarness();
  try {
    const pinned = seedActiveProxy(harness, "http://1.1.1.1:8080");
    seedTicket(harness, "1.other", "http://2.2.2.2:8080");
    assert.deepEqual(harness.tickets.egressesWithoutTicket([pinned]), [pinned]);

    const pending = harness.queue.acquire(undefined, pinned);
    assert.deepEqual(harness.mintPriority.ids(), [pinned]);
    assert.deepEqual(harness.tickets.egressesWithoutTicket(harness.mintPriority.ids()), [pinned]);

    seedTicket(harness, "1.pinned", "http://1.1.1.1:8080");
    assert.deepEqual(harness.tickets.egressesWithoutTicket([pinned]), []);
    harness.queue.drain();
    assert.equal((await pending).ticket.proxyId, pinned);
  } finally {
    harness.close();
  }
});
