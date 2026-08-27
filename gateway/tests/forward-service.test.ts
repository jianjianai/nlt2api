import assert from "node:assert/strict";
import { test } from "node:test";
import { ForwardService, validateChatRequest } from "~/server/utils/forward-service.ts";
import { toHttpError } from "~/server/utils/error-mapping.ts";
import { HttpError } from "~/server/utils/http.ts";
import { ProxyTransportError } from "~/server/utils/proxy.ts";
import { UpstreamError } from "~/server/utils/upstream-http.ts";
import { upstreamErrorFrom } from "~/server/utils/upstream.ts";
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

test("validateChatRequest enforces the minimal client contract", () => {
  assert.deepEqual(validateChatRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }), { model: "m", stream: false });
  assert.equal(validateChatRequest({ model: "m", messages: [{}], stream: true }).stream, true);
  assert.throws(() => validateChatRequest({ messages: [{}] }), HttpError);
  assert.throws(() => validateChatRequest({ model: "", messages: [{}] }), HttpError);
  assert.throws(() => validateChatRequest({ model: "m", messages: [] }), HttpError);
  assert.throws(() => validateChatRequest({ model: "m" }), HttpError);
  assert.throws(() => validateChatRequest({ model: "m", messages: [{}], stream: "yes" }), HttpError);
});

test("upstreamErrorFrom classifies captcha, capacity and rate limits", () => {
  assert.equal(upstreamErrorFrom(403, JSON.stringify({ error: { message: "Captcha verification failed" } })).kind, "captcha");
  assert.equal(upstreamErrorFrom(503, JSON.stringify({ error: { message: "Model busy, retry later" } })).kind, "model_capacity");
  assert.equal(upstreamErrorFrom(429, "{}").kind, "rate_limit");
  assert.equal(upstreamErrorFrom(500, "boom").kind, "upstream");
  assert.equal(upstreamErrorFrom(403, "forbidden").kind, "upstream");
});

test("upstream and proxy failures keep their status instead of collapsing to 500", () => {
  const upstream = toHttpError(upstreamErrorFrom(429, JSON.stringify({ error: { message: "slow down" }, retry_after: 7 })));
  assert.equal(upstream.status, 429);
  assert.equal(upstream.code, "rate_limit_exceeded");
  assert.equal(upstream.retryAfterSeconds, 7);

  const capacity = toHttpError(upstreamErrorFrom(503, JSON.stringify({ error: { message: "Model busy, retry later" } })));
  assert.equal(capacity.status, 503);
  assert.equal(capacity.code, "model_busy");

  const transport = toHttpError(new ProxyTransportError("Proxy connection was refused."));
  assert.equal(transport.status, 502);
  assert.equal(transport.code, "proxy_transport_error");

  // An HttpError passes through untouched; anything unknown stays a generic 500.
  const passthrough = new HttpError(404, "nope", "invalid_request_error");
  assert.equal(toHttpError(passthrough), passthrough);
  assert.equal(toHttpError(new Error("boom")).status, 500);
});

test("an empty pool returns 503 with a Retry-After hint when queueing is off", async () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ queueMaxSize: 0 });
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async () => new Response("{}"),
    });
    await assert.rejects(
      () => forward.chat({ model: "m", messages: [] }),
      (error: unknown) => error instanceof HttpError && error.status === 503 && error.code === "ticket_pool_empty",
    );
  } finally {
    harness.close();
  }
});

test("a successful call consumes exactly one pair", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.token");
    const seen: string[] = [];
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async (options) => {
        seen.push(options.ticket.token);
        return new Response("{}", { status: 200 });
      },
    });
    const response = await forward.chat({ model: "m", messages: [] });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ["1.token"]);
    // The upstream redeems the ticket, so the pair must not linger in the pool.
    assert.equal(harness.tickets.totalCount(), 0);
  } finally {
    harness.close();
  }
});

test("a captcha rejection retries with a different pair", async () => {
  const harness = createHarness();
  try {
    seedActiveProxy(harness, "http://1.2.3.4:8080");
    seedActiveProxy(harness, "http://5.6.7.8:8080");
    seedTicket(harness, "1.first", "http://1.2.3.4:8080");
    seedTicket(harness, "1.second", "http://5.6.7.8:8080");

    const seen: string[] = [];
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async (options) => {
        seen.push(options.ticket.token);
        if (seen.length === 1) throw upstreamErrorFrom(403, JSON.stringify({ error: { message: "Captcha verification failed" } }));
        return new Response("{}", { status: 200 });
      },
    });
    const response = await forward.chat({ model: "m", messages: [] });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
  } finally {
    harness.close();
  }
});

test("a transport failure records a proxy failure", async () => {
  const harness = createHarness();
  try {
    const proxyId = seedActiveProxy(harness, "http://1.2.3.4:8080");
    seedTicket(harness, "1.token", "http://1.2.3.4:8080");
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async () => {
        throw new ProxyTransportError("Proxy connection was refused.");
      },
    });
    await assert.rejects(() => forward.chat({ model: "m", messages: [] }), ProxyTransportError);
    assert.equal(harness.proxies.require(proxyId).failureCount, 1);
  } finally {
    harness.close();
  }
});

test("a non-retryable upstream error surfaces immediately", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.token");
    let calls = 0;
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async () => {
        calls += 1;
        throw upstreamErrorFrom(400, JSON.stringify({ error: { message: "bad model" } }));
      },
    });
    await assert.rejects(() => forward.chat({ model: "m", messages: [] }), UpstreamError);
    assert.equal(calls, 1);
  } finally {
    harness.close();
  }
});

test("attempts are capped by maxAttempts", async () => {
  const harness = createHarness();
  try {
    harness.settings.patch({ maxAttempts: 2 });
    seedActiveProxy(harness, "http://1.2.3.4:8080");
    seedActiveProxy(harness, "http://5.6.7.8:8080");
    seedActiveProxy(harness, "http://9.9.9.9:8080");
    seedTicket(harness, "1.a", "http://1.2.3.4:8080");
    seedTicket(harness, "1.b", "http://5.6.7.8:8080");
    seedTicket(harness, "1.c", "http://9.9.9.9:8080");

    let calls = 0;
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async () => {
        calls += 1;
        throw upstreamErrorFrom(503, "unavailable");
      },
    });
    await assert.rejects(() => forward.chat({ model: "m", messages: [] }), UpstreamError);
    assert.equal(calls, 2);
  } finally {
    harness.close();
  }
});

test("a request waits for a pair instead of failing on an empty pool", async () => {
  const harness = createHarness();
  try {
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async (options) => new Response(options.ticket.token, { status: 200 }),
    });
    const pending = forward.chat({ model: "m", messages: [] });
    // The pool is empty, so the request is parked rather than rejected.
    await Promise.resolve();
    assert.equal(harness.queue.waiting(), 1);
    seedTicket(harness, "1.minted");
    harness.queue.drain();
    assert.equal(await (await pending).text(), "1.minted");
  } finally {
    harness.close();
  }
});

test("a retry gives up with the original error rather than queueing again", async () => {
  const harness = createHarness();
  try {
    seedTicket(harness, "1.only");
    let calls = 0;
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      chat: async () => {
        calls += 1;
        throw upstreamErrorFrom(503, "unavailable");
      },
    });
    await assert.rejects(() => forward.chat({ model: "m", messages: [] }), UpstreamError);
    assert.equal(calls, 1);
    assert.equal(harness.queue.waiting(), 0);
  } finally {
    harness.close();
  }
});

test("the model catalog is cached until its TTL elapses", async () => {
  const harness = createHarness();
  try {
    let calls = 0;
    const forward = new ForwardService({
      settings: harness.settings,
      proxies: harness.proxies,
      tickets: harness.tickets,
      queue: harness.queue,
      demand: harness.demand,
      affinity: harness.affinity,
      catalog: async () => {
        calls += 1;
        return [{ id: "m", freeForAnonymous: true }];
      },
    });
    await forward.models();
    await forward.models();
    assert.equal(calls, 1);
    forward.invalidateModelsCache();
    await forward.models();
    assert.equal(calls, 2);
  } finally {
    harness.close();
  }
});
