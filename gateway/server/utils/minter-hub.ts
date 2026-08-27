import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getGatewayConfig } from "~/server/utils/config.ts";
import { allRows } from "~/server/utils/database.ts";
import { HttpError } from "~/server/utils/http.ts";
import { redactProxyUrls } from "~/server/utils/proxy.ts";
import type { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { TicketPoolService } from "~/server/utils/ticket-pool.ts";
import {
  blamesProxy,
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_HELLO_TIMEOUT,
  CLOSE_PROTOCOL_VIOLATION,
  CLOSE_REPLACED,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  MAX_PROTOCOL_VIOLATIONS,
  parseMinterMessage,
  type GatewayToMinter,
  type HelloMessage,
  type ScreenshotReplyMessage,
} from "~/server/utils/minter-protocol.ts";
import type { MinterSessionPublic, MinterSessionRecord } from "~/server/utils/types.ts";

/** Minimal surface the hub needs from a peer, so tests can drive it with a fake. */
export interface MinterPeer {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly remoteAddress?: string | undefined;
}

interface Connection {
  peer: MinterPeer;
  sessionId?: string;
  agentId?: string;
  concurrency: number;
  leases: Set<string>;
  inflight: Map<string, ReturnType<typeof setTimeout>>;
  /** Screenshot requests awaiting their reply, keyed by request id. */
  pendingScreenshots: Map<string, (reply: ScreenshotReplyMessage) => void>;
  lastSeenAt: number;
  violations: number;
  helloTimer?: ReturnType<typeof setTimeout>;
}

interface SessionRow {
  id: string;
  agent_id: string;
  label: string | null;
  version: string;
  platform: string;
  concurrency: number;
  remote_addr: string | null;
  connected_at: number;
  last_seen_at: number;
  disconnected_at: number | null;
  minted_count: number;
  failed_count: number;
  last_error: string | null;
}

function toSessionRecord(row: SessionRow): MinterSessionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ...(row.label ? { label: row.label } : {}),
    version: row.version,
    platform: row.platform,
    concurrency: row.concurrency,
    ...(row.remote_addr ? { remoteAddr: row.remote_addr } : {}),
    connectedAt: row.connected_at,
    lastSeenAt: row.last_seen_at,
    ...(row.disconnected_at !== null ? { disconnectedAt: row.disconnected_at } : {}),
    mintedCount: row.minted_count,
    failedCount: row.failed_count,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

export interface MinterHubDependencies {
  db: DatabaseSync;
  settings: SettingsStore;
  proxies: ProxyPoolService;
  tickets: TicketPoolService;
  serverVersion: string;
  now?: () => number;
  /** Invoked after a ticket is accepted so a queued request can take it at once. */
  onTicketAccepted?: () => void;
}

/**
 * Tracks every connected minter, validates the wire protocol, and owns the
 * lease/ticket handoff. All authority stays here: a minter can only ask.
 */
export class MinterHub {
  private readonly db: DatabaseSync;
  private readonly settings: SettingsStore;
  private readonly proxies: ProxyPoolService;
  private readonly tickets: TicketPoolService;
  private readonly serverVersion: string;
  private readonly now: () => number;
  private readonly onTicketAccepted: (() => void) | undefined;
  private readonly connections = new Map<MinterPeer, Connection>();

  constructor(dependencies: MinterHubDependencies) {
    this.db = dependencies.db;
    this.settings = dependencies.settings;
    this.proxies = dependencies.proxies;
    this.tickets = dependencies.tickets;
    this.serverVersion = dependencies.serverVersion;
    this.now = dependencies.now ?? Date.now;
    this.onTicketAccepted = dependencies.onTicketAccepted;
  }

  /** Marks sessions from a previous process offline and frees their leases. */
  recoverAfterRestart(): void {
    this.db.prepare("UPDATE minter_sessions SET disconnected_at = ? WHERE disconnected_at IS NULL")
      .run(this.now());
    this.proxies.resetLeases();
  }

  open(peer: MinterPeer): void {
    const connection: Connection = {
      peer,
      concurrency: 1,
      leases: new Set(),
      inflight: new Map(),
      pendingScreenshots: new Map(),
      lastSeenAt: this.now(),
      violations: 0,
    };
    // A peer that never identifies itself would otherwise occupy a slot forever.
    connection.helloTimer = setTimeout(() => {
      if (!connection.sessionId) peer.close(CLOSE_HELLO_TIMEOUT, "hello_timeout");
    }, HELLO_TIMEOUT_MS);
    connection.helloTimer.unref?.();
    this.connections.set(peer, connection);
  }

  close(peer: MinterPeer): void {
    const connection = this.connections.get(peer);
    if (!connection) return;
    if (connection.helloTimer) clearTimeout(connection.helloTimer);
    for (const timer of connection.inflight.values()) clearTimeout(timer);
    connection.inflight.clear();
    if (connection.sessionId) {
      this.proxies.releaseSessionLeases(connection.sessionId);
      this.db.prepare("UPDATE minter_sessions SET disconnected_at = ?, last_seen_at = ? WHERE id = ?")
        .run(this.now(), this.now(), connection.sessionId);
    }
    this.rejectPendingScreenshots(connection.sessionId);
    this.connections.delete(peer);
  }

  message(peer: MinterPeer, raw: string): void {
    const connection = this.connections.get(peer);
    if (!connection) return;
    connection.lastSeenAt = this.now();
    const message = parseMinterMessage(raw);
    if (!message) {
      connection.violations += 1;
      if (connection.violations >= MAX_PROTOCOL_VIOLATIONS) {
        peer.close(CLOSE_PROTOCOL_VIOLATION, "protocol_violation");
      }
      return;
    }
    if (connection.sessionId) {
      this.db.prepare("UPDATE minter_sessions SET last_seen_at = ? WHERE id = ?").run(connection.lastSeenAt, connection.sessionId);
    }

    switch (message.type) {
      case "hello":
        this.handleHello(connection, message);
        return;
      case "ping":
        this.send(connection, { type: "pong", id: message.id });
        return;
      case "pong":
        return;
      case "proxy.lease":
        this.handleLease(connection, message.id, message.preferProxyId);
        return;
      case "lease.extend":
        this.handleExtend(connection, message.id, message.leaseId);
        return;
      case "lease.release":
        this.handleRelease(connection, message.leaseId);
        return;
      case "ticket.submit":
        this.handleSubmit(connection, message);
        return;
      case "mint.failed":
        this.handleFailure(connection, message.id, message.reason, message.leaseId, message.message);
        return;
      case "browser.screenshot.reply":
        this.handleScreenshotReply(connection, message);
        return;
    }
  }

  private handleHello(connection: Connection, message: HelloMessage): void {
    if (connection.sessionId) {
      connection.violations += 1;
      return;
    }
    if (connection.helloTimer) {
      clearTimeout(connection.helloTimer);
      connection.helloTimer = undefined;
    }
    // One agent identity means one live connection; a reconnect supersedes the
    // stale one and its leases go back to the pool immediately.
    for (const [otherPeer, other] of this.connections) {
      if (other !== connection && other.agentId === message.agentId) {
        otherPeer.close(CLOSE_REPLACED, "replaced");
        this.close(otherPeer);
      }
    }

    const now = this.now();
    const sessionId = randomUUID();
    this.db.prepare(`
      INSERT INTO minter_sessions (id, agent_id, label, version, platform, concurrency, remote_addr, connected_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      message.agentId,
      message.label ?? null,
      message.version,
      message.platform,
      message.concurrency,
      connection.peer.remoteAddress ?? null,
      now,
      now,
    );

    connection.sessionId = sessionId;
    connection.agentId = message.agentId;
    connection.concurrency = message.concurrency;

    const config = getGatewayConfig();
    this.send(connection, {
      type: "welcome",
      sessionId,
      serverVersion: this.serverVersion,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      siteKey: config.turnstileSiteKey,
      ticketTtlSeconds: this.settings.get().ticketTtlSeconds,
    });
  }

  private handleLease(connection: Connection, id: string, preferProxyId?: string): void {
    if (!connection.sessionId) return;
    const result = this.proxies.lease(connection.sessionId, preferProxyId);
    if ("reason" in result) {
      this.send(connection, {
        type: "proxy.unavailable",
        id,
        reason: result.reason,
        retryAfterMs: this.settings.get().refillIntervalSeconds * 1_000,
      });
      return;
    }
    connection.leases.add(result.leaseId);
    this.send(connection, {
      type: "proxy.leased",
      id,
      leaseId: result.leaseId,
      proxyId: result.proxyId,
      proxyUrl: result.proxyUrl,
      kind: result.kind,
      expiresAt: result.expiresAt,
    });
  }

  private handleExtend(connection: Connection, id: string, leaseId: string): void {
    if (!connection.sessionId) return;
    const expiresAt = this.proxies.extendLease(connection.sessionId, leaseId);
    if (expiresAt === undefined) {
      connection.leases.delete(leaseId);
      this.send(connection, { type: "lease.lost", id, leaseId, reason: "expired" });
      return;
    }
    this.send(connection, { type: "lease.extended", id, leaseId, expiresAt });
  }

  private handleRelease(connection: Connection, leaseId: string): void {
    if (!connection.sessionId) return;
    connection.leases.delete(leaseId);
    this.proxies.releaseLease(connection.sessionId, leaseId);
  }

  private handleSubmit(connection: Connection, message: Extract<ReturnType<typeof parseMinterMessage>, { type: "ticket.submit" }>): void {
    if (!connection.sessionId || !connection.agentId) return;
    const result = this.tickets.submit({
      sessionId: connection.sessionId,
      leaseId: message.leaseId,
      token: message.token,
      source: message.source,
      ...(message.userAgent ? { userAgent: message.userAgent } : {}),
      mintedAt: message.mintedAt,
      agentId: connection.agentId,
    });
    this.settleInflight(connection);
    if (!result.ok) {
      this.send(connection, { type: "ticket.rejected", id: message.id, reason: result.reason });
      this.recordEvent("rejected", connection.sessionId, result.reason);
      return;
    }
    this.db.prepare("UPDATE minter_sessions SET minted_count = minted_count + 1 WHERE id = ?").run(connection.sessionId);
    this.recordEvent("minted", connection.sessionId);
    this.send(connection, { type: "ticket.accepted", id: message.id, ticketId: result.ticketId, expiresAt: result.expiresAt });
    this.onTicketAccepted?.();
  }

  private handleFailure(connection: Connection, _id: string, reason: string, leaseId?: string, message?: string): void {
    if (!connection.sessionId) return;
    const detail = redactProxyUrls(message ?? reason).slice(0, 500);
    if (leaseId) {
      const proxy = this.proxies.resolveLease(connection.sessionId, leaseId);
      // Only transport-level reasons say anything about the proxy; a local
      // browser failure must not push a healthy proxy toward `unavailable`.
      if (proxy && blamesProxy(reason as never)) {
        this.proxies.markFailure(proxy.id, `mint: ${reason}`);
      } else {
        this.proxies.releaseLease(connection.sessionId, leaseId);
      }
      connection.leases.delete(leaseId);
    }
    this.db.prepare("UPDATE minter_sessions SET failed_count = failed_count + 1, last_error = ? WHERE id = ?")
      .run(detail, connection.sessionId);
    this.recordEvent("failed", connection.sessionId, reason);
    this.settleInflight(connection);
  }

  private recordEvent(outcome: "minted" | "failed" | "rejected", sessionId: string, reason?: string): void {
    this.db.prepare("INSERT INTO mint_events (at, outcome, session_id, reason) VALUES (?, ?, ?, ?)")
      .run(this.now(), outcome, sessionId, reason ?? null);
  }

  /** Drops one inflight slot; the oldest pending mint is the one being settled. */
  private settleInflight(connection: Connection): void {
    const first = connection.inflight.keys().next();
    if (first.done) return;
    const timer = connection.inflight.get(first.value);
    if (timer) clearTimeout(timer);
    connection.inflight.delete(first.value);
  }

  private send(connection: Connection, message: GatewayToMinter): void {
    try {
      connection.peer.send(JSON.stringify(message));
    } catch {
      // The peer vanished mid-write; close() will clean up its state.
    }
  }

  /** Total mint requests dispatched but not yet resolved across all sessions. */
  inflightTotal(): number {
    let total = 0;
    for (const connection of this.connections.values()) total += connection.inflight.size;
    return total;
  }

  /**
   * Dispatches `count` mint requests spread over online sessions, respecting
   * each session's remaining concurrency. Returns how many were dispatched.
   */
  dispatchMintRequests(count: number): number {
    if (count <= 0) return 0;
    const settings = this.settings.get();
    const timeoutMs = settings.mintRequestTimeoutSeconds * 1_000;
    const sessions = [...this.connections.values()].filter((connection) => connection.sessionId);
    if (sessions.length === 0) return 0;

    let remaining = count;
    let dispatched = 0;
    for (const connection of sessions) {
      if (remaining <= 0) break;
      const capacity = connection.concurrency - connection.inflight.size;
      if (capacity <= 0) continue;
      const batch = Math.min(capacity, remaining);
      const id = randomUUID();
      this.send(connection, {
        type: "mint.request",
        id,
        count: batch,
        deadlineMs: this.now() + timeoutMs,
      });
      for (let index = 0; index < batch; index += 1) {
        const slot = `${id}:${index}`;
        const timer = setTimeout(() => connection.inflight.delete(slot), timeoutMs);
        timer.unref?.();
        connection.inflight.set(slot, timer);
      }
      remaining -= batch;
      dispatched += batch;
    }
    return dispatched;
  }

  /** Closes connections that stopped sending anything within the heartbeat window. */
  sweepHeartbeats(): void {
    const cutoff = this.now() - HEARTBEAT_TIMEOUT_MS;
    for (const [peer, connection] of [...this.connections]) {
      if (connection.lastSeenAt < cutoff) {
        peer.close(CLOSE_HEARTBEAT_TIMEOUT, "heartbeat_timeout");
        this.close(peer);
      }
    }
  }

  disconnectSession(sessionId: string): boolean {
    for (const [peer, connection] of [...this.connections]) {
      if (connection.sessionId === sessionId) {
        peer.close(1000, "disconnected_by_admin");
        this.close(peer);
        return true;
      }
    }
    return false;
  }

  /**
   * Asks one online minter for a screenshot of its resident browser. Resolves
   * with the base64 PNG, or throws a descriptive HttpError on any failure.
   */
  requestScreenshot(
    sessionId: string,
    kind: "page" | "fullpage",
    timeoutMs = 15_000,
  ): Promise<string> {
    const connection = [...this.connections.values()].find((candidate) => candidate.sessionId === sessionId);
    if (!connection) {
      return Promise.reject(new HttpError(404, "No online authorization service with that session id.", "invalid_request_error", "id", "session_not_found"));
    }
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        connection.pendingScreenshots.delete(id);
        reject(new HttpError(504, "The authorization service did not answer the screenshot request in time.", "server_error", undefined, "screenshot_timeout"));
      }, timeoutMs);
      timer.unref?.();
      connection.pendingScreenshots.set(id, (reply) => {
        clearTimeout(timer);
        connection.pendingScreenshots.delete(id);
        if (reply.ok && reply.pngBase64) resolve(reply.pngBase64);
        else reject(new HttpError(502, reply.error ?? "The authorization service failed to capture a screenshot.", "server_error", undefined, "screenshot_failed"));
      });
      this.send(connection, { type: "browser.screenshot.request", id, kind });
    });
  }

  private handleScreenshotReply(connection: Connection, reply: ScreenshotReplyMessage): void {
    const settle = connection.pendingScreenshots.get(reply.id);
    if (!settle) return;
    connection.pendingScreenshots.delete(reply.id);
    settle(reply);
  }

  private rejectPendingScreenshots(sessionId: string | undefined): void {
    if (!sessionId) return;
    for (const connection of this.connections.values()) {
      if (connection.sessionId !== sessionId) continue;
      for (const settle of connection.pendingScreenshots.values()) {
        settle({ type: "browser.screenshot.reply", id: "", ok: false, error: "connection closed" });
      }
      connection.pendingScreenshots.clear();
    }
  }

  onlineCount(): number {
    let total = 0;
    for (const connection of this.connections.values()) if (connection.sessionId) total += 1;
    return total;
  }

  /** Online sessions first, then the most recent offline ones for context. */
  snapshot(historyLimit = 20): MinterSessionPublic[] {
    const live = new Map<string, Connection>();
    for (const connection of this.connections.values()) {
      if (connection.sessionId) live.set(connection.sessionId, connection);
    }
    const onlineRows = allRows<SessionRow>(this.db, "SELECT * FROM minter_sessions WHERE disconnected_at IS NULL ORDER BY connected_at DESC");
    const offlineRows = allRows<SessionRow>(
      this.db,
      "SELECT * FROM minter_sessions WHERE disconnected_at IS NOT NULL ORDER BY disconnected_at DESC LIMIT ?",
      historyLimit,
    );
    return [...onlineRows, ...offlineRows].map((row) => {
      const connection = live.get(row.id);
      return {
        ...toSessionRecord(row),
        online: Boolean(connection),
        inflight: connection?.inflight.size ?? 0,
        leases: connection?.leases.size ?? 0,
      };
    });
  }

  /** Mint outcomes within the trailing window, for the overview dashboard. */
  recentRate(windowMinutes = 5): { minted: number; failed: number; windowMinutes: number } {
    const since = this.now() - windowMinutes * 60_000;
    const rows = allRows<{ outcome: string; total: number }>(
      this.db,
      "SELECT outcome, COUNT(*) AS total FROM mint_events WHERE at >= ? GROUP BY outcome",
      since,
    );
    let minted = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.outcome === "minted") minted += row.total;
      else failed += row.total;
    }
    return { minted, failed, windowMinutes };
  }

  pruneEvents(retentionMinutes = 60): void {
    this.db.prepare("DELETE FROM mint_events WHERE at < ?").run(this.now() - retentionMinutes * 60_000);
  }
}
