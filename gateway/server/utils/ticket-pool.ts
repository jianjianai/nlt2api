import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { allRows, getRow, immediateTransaction } from "~/server/utils/database.ts";
import { maskProxyUrl } from "~/server/utils/proxy.ts";
import type { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { TicketPair, TicketPublic, TicketRecord } from "~/server/utils/types.ts";

interface TicketRow {
  id: string;
  proxy_id: string;
  token: string;
  source: string;
  user_agent: string | null;
  minted_at: number;
  expires_at: number;
  claimed_at: number | null;
  minter_id: string | null;
}

function toRecord(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    proxyId: row.proxy_id,
    token: row.token,
    source: row.source,
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    mintedAt: row.minted_at,
    expiresAt: row.expires_at,
    ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
    ...(row.minter_id ? { minterId: row.minter_id } : {}),
  };
}

export function maskToken(token: string): string {
  return token.length <= 8 ? "***" : `${token.slice(0, 8)}***`;
}

export interface TicketSubmission {
  sessionId: string;
  leaseId: string;
  token: string;
  source: string;
  userAgent?: string;
  mintedAt: number;
  agentId: string;
}

export type TicketAcceptance =
  | { ok: true; ticketId: string; expiresAt: number }
  | { ok: false; reason: "lease_invalid" | "proxy_inactive" | "already_expired" };

export interface TicketPoolDependencies {
  db: DatabaseSync;
  settings: SettingsStore;
  proxies: ProxyPoolService;
  now?: () => number;
}

export class TicketPoolService {
  private readonly db: DatabaseSync;
  private readonly settings: SettingsStore;
  private readonly proxies: ProxyPoolService;
  private readonly now: () => number;

  constructor(dependencies: TicketPoolDependencies) {
    this.db = dependencies.db;
    this.settings = dependencies.settings;
    this.proxies = dependencies.proxies;
    this.now = dependencies.now ?? Date.now;
  }

  /**
   * Stores one (proxy, ticket) pair. `mintedAt` is clamped to the gateway clock
   * so a minter whose clock runs ahead cannot make a ticket appear younger than
   * it is, which would let an already-dead ticket into the pool.
   */
  submit(submission: TicketSubmission): TicketAcceptance {
    const settings = this.settings.get();
    const now = this.now();
    const proxy = this.proxies.resolveLease(submission.sessionId, submission.leaseId);
    if (!proxy) return { ok: false, reason: "lease_invalid" };
    if (proxy.status !== "active") return { ok: false, reason: "proxy_inactive" };

    const mintedAt = Math.min(submission.mintedAt, now);
    const expiresAt = mintedAt + settings.ticketTtlSeconds * 1_000;
    if (expiresAt - now < settings.ticketMinRemainingSeconds * 1_000) {
      return { ok: false, reason: "already_expired" };
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO tickets (id, proxy_id, token, source, user_agent, minted_at, expires_at, minter_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, proxy.id, submission.token, submission.source, submission.userAgent ?? null, mintedAt, expiresAt, submission.agentId);
    return { ok: true, ticketId: id, expiresAt };
  }

  /**
   * Takes one pair. Rate-limited egress IPs are excluded, and among the rest the
   * one idle longest wins so traffic rotates instead of hammering a single IP.
   * Within one proxy the ticket closest to expiry goes first, which minimises how
   * many expire unused. `preferProxyId` pins a conversation to the egress it
   * started on when that proxy still has a usable ticket.
   */
  claim(preferProxyId?: string): TicketPair | undefined {
    const settings = this.settings.get();
    const now = this.now();
    const floor = now + settings.ticketMinRemainingSeconds * 1_000;
    return immediateTransaction(this.db, () => {
      const select = (proxyId?: string) => getRow<TicketRow & { proxy_url: string }>(this.db, `
        SELECT t.*, p.url AS proxy_url FROM tickets t
        JOIN proxies p ON p.id = t.proxy_id
        WHERE t.claimed_at IS NULL AND t.expires_at >= ? AND p.status = 'active'
          AND (p.rate_limited_until IS NULL OR p.rate_limited_until < ?)
          ${proxyId ? "AND p.id = ?" : ""}
        ORDER BY COALESCE(p.last_used_at, 0) ASC, t.expires_at ASC
        LIMIT 1
      `, ...(proxyId ? [floor, now, proxyId] : [floor, now]));
      // Affinity is best-effort: a pinned egress with nothing left must not stall
      // the request, so fall back to the rotation order.
      const row = (preferProxyId ? select(preferProxyId) : undefined) ?? select();
      if (!row) return undefined;
      this.db.prepare("UPDATE tickets SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL").run(now, row.id);
      this.db.prepare("UPDATE proxies SET last_used_at = ? WHERE id = ?").run(now, row.proxy_id);
      return { ticket: toRecord(row), proxyUrl: row.proxy_url };
    });
  }

  /** A consumed or upstream-redeemed ticket can never be reused; it is dropped. */
  drop(ticketId: string): void {
    this.db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);
  }

  availableCount(): number {
    const settings = this.settings.get();
    const now = this.now();
    const floor = now + settings.ticketMinRemainingSeconds * 1_000;
    const row = getRow<{ total: number }>(this.db, `
      SELECT COUNT(*) AS total FROM tickets t
      JOIN proxies p ON p.id = t.proxy_id
      WHERE t.claimed_at IS NULL AND t.expires_at >= ? AND p.status = 'active'
        AND (p.rate_limited_until IS NULL OR p.rate_limited_until < ?)
    `, floor, now);
    return row?.total ?? 0;
  }

  totalCount(): number {
    return getRow<{ total: number }>(this.db, "SELECT COUNT(*) AS total FROM tickets")?.total ?? 0;
  }

  /** Removes expired tickets and claims that were never resolved. */
  cleanup(): number {
    const now = this.now();
    const staleClaim = now - 5 * 60_000;
    const result = this.db.prepare("DELETE FROM tickets WHERE expires_at < ? OR (claimed_at IS NOT NULL AND claimed_at < ?)")
      .run(now, staleClaim);
    return Number(result.changes);
  }

  clear(): number {
    return Number(this.db.prepare("DELETE FROM tickets").run().changes);
  }

  snapshot(limit = 100): TicketPublic[] {
    const now = this.now();
    const rows = allRows<TicketRow & { proxy_url: string }>(this.db, `
      SELECT t.*, p.url AS proxy_url FROM tickets t
      JOIN proxies p ON p.id = t.proxy_id
      WHERE t.claimed_at IS NULL
      ORDER BY t.expires_at ASC
      LIMIT ?
    `, Math.min(Math.max(limit, 1), 500));
    return rows.map((row) => ({
      id: row.id,
      proxyId: row.proxy_id,
      maskedProxyUrl: maskProxyUrl(row.proxy_url),
      maskedToken: maskToken(row.token),
      source: row.source,
      mintedAt: row.minted_at,
      expiresAt: row.expires_at,
      remainingMs: Math.max(0, row.expires_at - now),
      ...(row.minter_id ? { minterId: row.minter_id } : {}),
    }));
  }
}
