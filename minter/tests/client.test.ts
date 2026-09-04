import assert from "node:assert/strict";
import { test } from "node:test";
import { MinterClient, type Minter } from "~/src/client.ts";
import { loadConfig } from "~/src/config.ts";
import { MintError } from "~/src/cdp.ts";

interface Sent {
  type: string;
  [key: string]: unknown;
}

/** Loopback socket: whatever the client sends is captured, and tests push replies. */
class FakeSocket {
  readonly sent: Sent[] = [];
  closed = false;
  attach: ((raw: string) => void) | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }

  close(): void {
    this.closed = true;
  }

  last(type: string): Sent | undefined {
    return [...this.sent].reverse().find((message) => message.type === type);
  }

  all(type: string): Sent[] {
    return this.sent.filter((message) => message.type === type);
  }
}

class FakeMinter implements Minter {
  proxyUrl: string | undefined;
  siteKey = "0xINITIAL";
  readonly calls: string[] = [];
  closed = false;
  screenshotRequests: string[] = [];
  /** Set to keep `mint` pending, so the worker stays busy during a test. */
  blockMint: Promise<void> | undefined;
  private counter = 0;

  constructor(private readonly behaviour: (call: number) => void = () => {}) {}

  async mint(proxyUrl: string): Promise<{ token: string; mintedAt: number; userAgent?: string }> {
    this.counter += 1;
    this.calls.push(proxyUrl);
    this.proxyUrl = proxyUrl;
    if (this.blockMint) await this.blockMint;
    this.behaviour(this.counter);
    return { token: `token-${this.counter}`, mintedAt: 1_700_000_000_000, userAgent: "UA/1.0" };
  }

  async screenshot(kind: "page" | "fullpage"): Promise<string> {
    this.screenshotRequests.push(kind);
    return "aW1n";
  }

  setSiteKey(siteKey: string): void {
    this.siteKey = siteKey;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface Harness {
  client: MinterClient;
  socket: FakeSocket;
  minters: FakeMinter[];
  started: Promise<void>;
  welcome(siteKey?: string): void;
  push(payload: unknown): void;
  stop(): Promise<void>;
}

function createHarness(options: { concurrency?: number; behaviour?: (call: number) => void; sticky?: { min: number; max: number } } = {}): Harness {
  const socket = new FakeSocket();
  const minters: FakeMinter[] = [];
  const config = loadConfig({
    GATEWAY_URL: "http://gateway:3000",
    MINTER_TOKEN: "secret",
    MINTER_AGENT_ID: "agent-1",
    MINTER_CONCURRENCY: String(options.concurrency ?? 1),
  });
  const client = new MinterClient({
    config,
    version: "1.0.0",
    createMinter: () => {
      const minter = new FakeMinter(options.behaviour);
      minters.push(minter);
      return minter;
    },
    connect: async () => socket,
    log: () => {},
  });
  const started = client.start();
  const push = (payload: unknown) => client.handleFrame(JSON.stringify(payload));
  return {
    client,
    socket,
    minters,
    started,
    push,
    welcome(siteKey = "0xGATEWAY") {
      push({
        type: "welcome",
        sessionId: "s1",
        siteKey,
        serverVersion: "1.0.0",
        heartbeatIntervalMs: 60_000,
        ticketTtlSeconds: 170,
        ...(options.sticky ? { stickyMintsMin: options.sticky.min, stickyMintsMax: options.sticky.max } : {}),
      });
    },
    async stop() {
      await client.stop();
      await started;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the client identifies itself immediately after connecting", async () => {
  const harness = createHarness();
  try {
    await tick();
    const hello = harness.socket.last("hello");
    assert.equal(hello?.agentId, "agent-1");
    assert.equal(hello?.concurrency, 1);
    assert.equal(hello?.version, "1.0.0");
    assert.equal(typeof hello?.platform, "string");
  } finally {
    await harness.stop();
  }
});

test("the gateway's site key overrides the local default", async () => {
  const harness = createHarness();
  try {
    await tick();
    harness.welcome("0xFROMGATEWAY");
    assert.equal(harness.minters[0]?.siteKey, "0xFROMGATEWAY");
  } finally {
    await harness.stop();
  }
});

test("a ping is answered with a matching pong", async () => {
  const harness = createHarness();
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "ping", id: "p1" });
    assert.deepEqual(harness.socket.last("pong"), { type: "pong", id: "p1" });
  } finally {
    await harness.stop();
  }
});

test("a mint request leases a proxy, mints, and submits the ticket", async () => {
  const harness = createHarness();
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();

    const lease = harness.socket.last("proxy.lease");
    assert.ok(lease);
    harness.push({
      type: "proxy.leased",
      id: lease.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    await tick();
    await tick();

    const submit = harness.socket.last("ticket.submit");
    assert.equal(submit?.leaseId, "L1");
    assert.equal(submit?.token, "token-1");
    assert.equal(submit?.source, "model-embed");
    assert.equal(submit?.userAgent, "UA/1.0");
    assert.equal(harness.minters[0]?.calls[0], "http://1.2.3.4:8080");
    assert.equal(harness.socket.last("lease.release")?.leaseId, "L1");
  } finally {
    await harness.stop();
  }
});

test("a later lease request prefers the proxy the browser is already bound to", async () => {
  const harness = createHarness();
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    const first = harness.socket.last("proxy.lease");
    assert.equal(first?.preferProxyId, undefined);
    harness.push({
      type: "proxy.leased",
      id: first!.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    await tick();
    await tick();

    harness.push({ type: "mint.request", id: "m2", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    assert.equal(harness.socket.last("proxy.lease")?.preferProxyId, "P1");
  } finally {
    await harness.stop();
  }
});

test("a welcome without a sticky band leaves prefer-on-renewal untouched", async () => {
  const harness = createHarness(); // no sticky option
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    const lease = harness.socket.last("proxy.lease");
    harness.push({
      type: "proxy.leased",
      id: lease!.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    await tick();
    await tick();

    harness.push({ type: "mint.request", id: "m2", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    assert.equal(harness.socket.last("proxy.lease")?.preferProxyId, "P1");
  } finally {
    await harness.stop();
  }
});

test("after the sticky target the next lease request stops preferring the bound proxy", async () => {
  const harness = createHarness({ sticky: { min: 1, max: 1 } });
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    const first = harness.socket.last("proxy.lease");
    harness.push({
      type: "proxy.leased",
      id: first!.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    await tick();
    await tick();

    // Target 1 was just hit on P1, so the next request must not prefer it.
    harness.push({ type: "mint.request", id: "m2", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    assert.equal(harness.socket.last("proxy.lease")?.preferProxyId, undefined);
  } finally {
    await harness.stop();
  }
});

test("a batch rotates proxies mid-flight when the sticky target is reached", async () => {
  const harness = createHarness({ sticky: { min: 1, max: 1 } });
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 2, deadlineMs: Date.now() + 60_000 });
    await tick();
    const first = harness.socket.last("proxy.lease");
    harness.push({
      type: "proxy.leased",
      id: first!.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    // Let the first mint land; the mid-batch rotation then releases L1 and asks anew.
    await tick();
    await tick();
    await tick();
    const rotated = harness.socket.last("proxy.lease");
    assert.notEqual(rotated?.id, first?.id);
    assert.equal(rotated?.preferProxyId, undefined);
    harness.push({
      type: "proxy.leased",
      id: rotated!.id,
      leaseId: "L2",
      proxyId: "P2",
      proxyUrl: "http://5.6.7.8:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    await tick();
    await tick();

    const calls = harness.minters[0]?.calls ?? [];
    assert.equal(calls.length, 2);
    assert.equal(calls[0], "http://1.2.3.4:8080");
    assert.equal(calls[1], "http://5.6.7.8:8080");
    assert.equal(harness.socket.all("lease.release").length, 2);
  } finally {
    await harness.stop();
  }
});

test("proxy.unavailable ends the attempt without a failure report", async () => {
  const harness = createHarness();
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    const lease = harness.socket.last("proxy.lease");
    harness.push({ type: "proxy.unavailable", id: lease!.id, reason: "all_leased", retryAfterMs: 5_000 });
    await tick();

    assert.equal(harness.socket.last("ticket.submit"), undefined);
    assert.equal(harness.socket.last("mint.failed"), undefined);
    assert.equal(harness.minters[0]?.calls.length, 0);
  } finally {
    await harness.stop();
  }
});

test("a screenshot request is answered from an idle worker", async () => {
  const harness = createHarness();
  try {
    await tick();
    harness.welcome();
    // Bind a worker to a proxy first so the browser counts as resident.
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    const lease = harness.socket.last("proxy.lease");
    harness.push({
      type: "proxy.leased",
      id: lease!.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    await tick();
    await tick();

    harness.push({ type: "browser.screenshot.request", id: "s1", kind: "page" });
    await tick();
    const reply = harness.socket.last("browser.screenshot.reply");
    assert.equal(reply?.id, "s1");
    assert.equal(reply?.ok, true);
    assert.equal(reply?.pngBase64, "aW1n");
    assert.deepEqual(harness.minters[0]?.screenshotRequests, ["page"]);
  } finally {
    await harness.stop();
  }
});

test("a screenshot request without a resident browser fails cleanly", async () => {
  const harness = createHarness();
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "browser.screenshot.request", id: "s1", kind: "fullpage" });
    await tick();
    const reply = harness.socket.last("browser.screenshot.reply");
    assert.equal(reply?.id, "s1");
    assert.equal(reply?.ok, false);
    assert.ok(String(reply?.error).includes("no resident browser"));
    assert.equal(harness.minters[0]?.screenshotRequests.length, 0);
  } finally {
    await harness.stop();
  }
});

test("a screenshot request is answered while the only worker is minting", async () => {
  let release: (() => void) | undefined;
  const harness = createHarness();
  try {
    await tick();
    harness.welcome();
    // Bind the worker to a proxy, then leave it inside its mint loop — that is
    // the state a repeatedly failing minter is in when the admin asks for a shot.
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    const lease = harness.socket.last("proxy.lease");
    harness.minters[0]!.proxyUrl = "http://1.2.3.4:8080";
    harness.minters[0]!.blockMint = new Promise<void>((resolve) => { release = resolve; });
    harness.push({
      type: "proxy.leased",
      id: lease!.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    await tick();

    harness.push({ type: "browser.screenshot.request", id: "s1", kind: "page" });
    await tick();
    const reply = harness.socket.last("browser.screenshot.reply");
    assert.equal(reply?.ok, true);
    assert.equal(reply?.pngBase64, "aW1n");
  } finally {
    release?.();
    await harness.stop();
  }
});

test("a mint failure is reported with its lease and a bounded message", async () => {
  const harness = createHarness({
    behaviour: () => {
      throw new MintError("no_token", "x".repeat(900));
    },
  });
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    const lease = harness.socket.last("proxy.lease");
    harness.push({
      type: "proxy.leased",
      id: lease!.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    await tick();
    await tick();

    const failed = harness.socket.last("mint.failed");
    assert.equal(failed?.reason, "no_token");
    assert.equal(failed?.leaseId, "L1");
    assert.ok(String(failed?.message).length <= 512);
    assert.equal(harness.socket.last("lease.release"), undefined);
  } finally {
    await harness.stop();
  }
});

test("a batch renews the lease between mints on the same proxy", async () => {
  const harness = createHarness({ concurrency: 1 });
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 3, deadlineMs: Date.now() + 60_000 });
    await tick();
    const lease = harness.socket.last("proxy.lease");
    harness.push({
      type: "proxy.leased",
      id: lease!.id,
      leaseId: "L1",
      proxyId: "P1",
      proxyUrl: "http://1.2.3.4:8080",
      kind: "http",
      expiresAt: Date.now() + 120_000,
    });
    for (let index = 0; index < 8; index += 1) await tick();

    assert.equal(harness.socket.all("ticket.submit").length, 3);
    // Renewal happens before every mint after the first.
    assert.equal(harness.socket.all("lease.extend").length, 2);
    assert.equal(harness.minters[0]?.calls.length, 3);
  } finally {
    await harness.stop();
  }
});

test("a disconnect resolves pending lease requests instead of hanging", async () => {
  const harness = createHarness();
  try {
    await tick();
    harness.welcome();
    harness.push({ type: "mint.request", id: "m1", count: 1, deadlineMs: Date.now() + 60_000 });
    await tick();
    assert.ok(harness.socket.last("proxy.lease"));
    harness.client.handleDisconnect("test");
    await tick();
    assert.equal(harness.socket.last("ticket.submit"), undefined);
    assert.equal(harness.client.isConnected, false);
  } finally {
    await harness.stop();
  }
});

test("a mint request never mints more tickets than asked across workers", async () => {
  const harness = createHarness({ concurrency: 2 });
  try {
    await tick();
    harness.welcome();
    // Three tickets over two idle workers must total exactly three (2 + 1),
    // not ceil(3/2) each which would over-mint to four and desync the
    // gateway's inflight accounting.
    harness.push({ type: "mint.request", id: "m1", count: 3, deadlineMs: Date.now() + 60_000 });
    await tick();
    const leases = harness.socket.all("proxy.lease");
    assert.equal(leases.length, 2);
    leases.forEach((lease, index) => {
      harness.push({
        type: "proxy.leased",
        id: lease.id,
        leaseId: `L${index + 1}`,
        proxyId: `P${index + 1}`,
        proxyUrl: `http://1.2.3.${index + 1}:8080`,
        kind: "http",
        expiresAt: Date.now() + 120_000,
      });
    });
    for (let index = 0; index < 10; index += 1) await tick();

    assert.equal(harness.socket.all("ticket.submit").length, 3);
    const perWorker = harness.minters.map((minter) => minter.calls.length).sort();
    assert.deepEqual(perWorker, [1, 2]);
  } finally {
    await harness.stop();
  }
});

test("stop closes every worker's browser", async () => {
  const harness = createHarness({ concurrency: 2 });
  await tick();
  harness.welcome();
  await harness.stop();
  assert.equal(harness.minters.length, 2);
  for (const minter of harness.minters) assert.equal(minter.closed, true);
});
