import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MinterBrowser } from "./browser.ts";
import type { MintResult } from "./browser.ts";
import type { MinterConfig } from "./config.ts";
import { classifyMintFailure } from "./failure.ts";
import { redactProxyUrls } from "./proxy.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  INBOUND_SILENCE_TIMEOUT_MS,
  parseGatewayMessage,
  reconnectDelayMs,
  type GatewayMessage,
  type MintFailureReason,
} from "./protocol.ts";

/** Injection seam so tests can drive the client without a real browser. */
export interface Minter {
  mint(proxyUrl: string): Promise<MintResult>;
  screenshot(kind: "page" | "fullpage"): Promise<string>;
  setSiteKey(siteKey: string): void;
  close(): Promise<void>;
  readonly proxyUrl: string | undefined;
}

export interface Lease {
  leaseId: string;
  proxyId: string;
  proxyUrl: string;
  expiresAt: number;
}

interface PendingLease {
  resolve: (lease: Lease | undefined) => void;
}

interface Socket {
  send(data: string): void;
  close(): void;
}

export interface ClientDependencies {
  config: MinterConfig;
  version: string;
  createMinter?: (index: number) => Minter;
  connect?: (url: string, token: string) => Promise<Socket>;
  now?: () => number;
  log?: (message: string) => void;
}

interface Worker {
  index: number;
  minter: Minter;
  busy: boolean;
  /** Proxy this worker's browser is currently bound to; renewed when possible. */
  lastProxyId?: string;
}

async function connectWebSocket(url: string, token: string): Promise<Socket & { attach: (client: MinterClient) => void }> {
  // Node's global WebSocket accepts request headers; browsers never connect here.
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as never);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("WebSocket connection failed."));
    socket.onclose = (event: CloseEvent) => reject(new Error(`WebSocket closed before opening (code ${event.code}).`));
  });
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    attach: (client) => {
      socket.onmessage = (event: MessageEvent) => client.handleFrame(String(event.data));
      socket.onclose = (event: CloseEvent) => client.handleDisconnect(`code ${event.code} ${event.reason}`.trim());
      socket.onerror = () => client.handleDisconnect("socket error");
    },
  };
}

/**
 * Owns the gateway link and the local browser workers. All authority lives on
 * the gateway: this client only asks for proxies and reports outcomes.
 */
export class MinterClient {
  private readonly config: MinterConfig;
  private readonly version: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly connect: (url: string, token: string) => Promise<Socket>;
  private readonly workers: Worker[] = [];
  private readonly pendingLeases = new Map<string, PendingLease>();
  private socket: Socket | undefined;
  private sessionId: string | undefined;
  private siteKey: string;
  private heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private stopped = false;
  private connected = false;

  constructor(dependencies: ClientDependencies) {
    this.config = dependencies.config;
    this.version = dependencies.version;
    this.now = dependencies.now ?? Date.now;
    this.log = dependencies.log ?? ((message) => console.log(`[minter] ${message}`));
    this.connect = dependencies.connect ?? (async (url, token) => {
      const socket = await connectWebSocket(url, token);
      socket.attach(this);
      return socket;
    });
    this.siteKey = this.config.siteKey;

    const createMinter = dependencies.createMinter ?? ((index) => new MinterBrowser({
      port: this.config.basePort + index,
      profileDir: this.config.concurrency === 1 ? this.config.profileDir : `${this.config.profileDir}-${index + 1}`,
      display: this.config.display,
      siteKey: this.config.siteKey,
      mintTimeoutMs: this.config.mintTimeoutMs,
      idleReleaseMs: this.config.idleReleaseMs,
      ...(this.config.browserPath ? { executablePath: this.config.browserPath } : {}),
    }));
    for (let index = 0; index < this.config.concurrency; index += 1) {
      this.workers.push({ index, minter: createMinter(index), busy: false });
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    while (!this.stopped) {
      try {
        this.socket = await this.connect(this.config.wsUrl, this.config.token);
        this.reconnectAttempt = 0;
        this.connected = true;
        this.send({
          type: "hello",
          agentId: this.config.agentId,
          label: this.config.label,
          version: this.version,
          platform: `${process.platform}-${process.arch}`,
          concurrency: this.config.concurrency,
        });
        this.armSilenceTimer();
        await this.waitForDisconnect();
      } catch (error) {
        this.log(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.teardownLink();
      if (this.stopped) break;
      this.reconnectAttempt += 1;
      const wait = reconnectDelayMs(this.reconnectAttempt);
      this.log(`reconnecting in ${wait} ms (attempt ${this.reconnectAttempt})`);
      await delay(wait);
    }
  }

  private disconnectSignal: (() => void) | undefined;

  private waitForDisconnect(): Promise<void> {
    return new Promise<void>((resolve) => { this.disconnectSignal = resolve; });
  }

  handleDisconnect(reason: string): void {
    if (!this.connected) return;
    this.log(`disconnected: ${reason}`);
    this.connected = false;
    // Any outstanding lease request can never be answered on a dead link.
    for (const pending of this.pendingLeases.values()) pending.resolve(undefined);
    this.pendingLeases.clear();
    this.disconnectSignal?.();
    this.disconnectSignal = undefined;
  }

  private teardownLink(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    this.sessionId = undefined;
    this.connected = false;
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
    this.socket = undefined;
  }

  private armSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.log("no frames from the gateway; dropping the link");
      this.handleDisconnect("inbound silence");
    }, INBOUND_SILENCE_TIMEOUT_MS);
    this.silenceTimer.unref?.();
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch (error) {
      this.log(`send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  handleFrame(raw: string): void {
    this.armSilenceTimer();
    const message = parseGatewayMessage(raw);
    if (!message) return;
    this.handleMessage(message);
  }

  private handleMessage(message: GatewayMessage): void {
    switch (message.type) {
      case "welcome":
        this.sessionId = message.sessionId;
        this.heartbeatIntervalMs = message.heartbeatIntervalMs;
        // The gateway is the source of truth for the site key so a rotation
        // upstream needs no per-host reconfiguration.
        if (message.siteKey !== this.siteKey) {
          this.siteKey = message.siteKey;
          for (const worker of this.workers) worker.minter.setSiteKey(message.siteKey);
        }
        this.startHeartbeat();
        this.log(`connected to gateway ${message.serverVersion} as session ${message.sessionId}`);
        return;
      case "ping":
        this.send({ type: "pong", id: message.id });
        return;
      case "pong":
        return;
      case "mint.request":
        void this.handleMintRequest(message.count);
        return;
      case "proxy.leased": {
        this.pendingLeases.get(message.id)?.resolve({
          leaseId: message.leaseId,
          proxyId: message.proxyId,
          proxyUrl: message.proxyUrl,
          expiresAt: message.expiresAt,
        });
        this.pendingLeases.delete(message.id);
        return;
      }
      case "proxy.unavailable":
        this.pendingLeases.get(message.id)?.resolve(undefined);
        this.pendingLeases.delete(message.id);
        return;
      case "lease.extended":
      case "lease.lost":
      case "ticket.accepted":
        return;
      case "ticket.rejected":
        this.log(`gateway rejected a ticket: ${message.reason}`);
        return;
      case "browser.screenshot.request":
        void this.handleScreenshotRequest(message.id, message.kind);
        return;
    }
  }

  /** Answers the admin console's screenshot probe from any live browser. */
  private async handleScreenshotRequest(id: string, kind: "page" | "fullpage"): Promise<void> {
    const withBrowser = this.workers.filter((candidate) => candidate.minter.proxyUrl);
    // Capturing is read-only, so a busy worker is a valid source — and when
    // minting keeps failing every worker is busy, which is exactly when the
    // screenshot is being asked for.
    const worker = withBrowser.find((candidate) => !candidate.busy) ?? withBrowser[0];
    if (!worker) {
      this.send({ type: "browser.screenshot.reply", id, ok: false, error: "no resident browser available" });
      return;
    }
    try {
      const pngBase64 = await worker.minter.screenshot(kind);
      this.send({ type: "browser.screenshot.reply", id, ok: true, pngBase64 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({ type: "browser.screenshot.reply", id, ok: false, error: message.slice(0, 512) });
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.send({ type: "ping", id: randomUUID() }), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  /** Spreads a mint request over idle workers; ignored when none are free. */
  private async handleMintRequest(count: number): Promise<void> {
    const idle = this.workers.filter((worker) => !worker.busy).slice(0, count);
    await Promise.all(idle.map((worker) => this.runWorker(worker, Math.ceil(count / Math.max(idle.length, 1)))));
  }

  private async runWorker(worker: Worker, batch: number): Promise<void> {
    worker.busy = true;
    try {
      const lease = await this.requestLease(worker.lastProxyId);
      if (!lease) return;
      worker.lastProxyId = lease.proxyId;
      let minted = 0;
      try {
        while (minted < batch && this.connected) {
          // Renew before each mint after the first: the browser stays bound to
          // this proxy, so losing the lease mid-batch would waste the restart.
          if (minted > 0) this.send({ type: "lease.extend", id: randomUUID(), leaseId: lease.leaseId });
          const result = await worker.minter.mint(lease.proxyUrl);
          this.send({
            type: "ticket.submit",
            id: randomUUID(),
            leaseId: lease.leaseId,
            token: result.token,
            source: "model-embed",
            mintedAt: result.mintedAt,
            ...(result.userAgent ? { userAgent: result.userAgent } : {}),
          });
          minted += 1;
        }
      } catch (error) {
        const { reason, message } = classifyMintFailure(error);
        this.reportFailure(reason, lease.leaseId, message);
        return;
      }
      this.send({ type: "lease.release", leaseId: lease.leaseId });
    } finally {
      worker.busy = false;
    }
  }

  private reportFailure(reason: MintFailureReason, leaseId: string | undefined, message: string): void {
    const safe = redactProxyUrls(message).slice(0, 512);
    this.log(`mint failed (${reason}): ${safe}`);
    this.send({
      type: "mint.failed",
      id: randomUUID(),
      reason,
      ...(leaseId ? { leaseId } : {}),
      message: safe,
    });
  }

  /**
   * Asks for a proxy lease. `preferProxyId` renews the one this worker's browser
   * is already bound to, avoiding a process restart just to change --proxy-server.
   */
  private requestLease(preferProxyId: string | undefined): Promise<Lease | undefined> {
    if (!this.connected) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise<Lease | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingLeases.delete(id);
        resolve(undefined);
      }, 15_000);
      timer.unref?.();
      this.pendingLeases.set(id, {
        resolve: (lease) => {
          clearTimeout(timer);
          resolve(lease);
        },
      });
      this.send({ type: "proxy.lease", id, ...(preferProxyId ? { preferProxyId } : {}) });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.log("shutting down");
    this.handleDisconnect("shutdown");
    this.teardownLink();
    await Promise.all(this.workers.map((worker) => worker.minter.close().catch(() => undefined)));
  }
}
