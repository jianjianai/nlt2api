import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { allRows, getRow, immediateTransaction } from "~/server/utils/database.ts";
import { HttpError } from "~/server/utils/http.ts";
import { evictProxyDispatcher, isMintableProxy, maskProxyUrl, parseProxyImportLine } from "~/server/utils/proxy.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { ProxyCooldownReason, ProxyKind, ProxyPublic, ProxyRecord, ProxyStatus } from "~/server/utils/types.ts";

interface ProxyRow {
  id: string;
  url: string;
  kind: string;
  status: string;
  label: string | null;
  created_at: number;
  updated_at: number;
  checked_at: number | null;
  healthy_at: number | null;
  latency_ms: number | null;
  throughput_bps: number | null;
  failure_count: number;
  last_error: string | null;
  reject_reason: string | null;
  retry_after: number | null;
  rate_limited_until: number | null;
  cooldown_reason: string | null;
  last_used_at: number | null;
  last_minted_at: number | null;
  leased_by: string | null;
  lease_id: string | null;
  lease_expires: number | null;
}

function toRecord(row: ProxyRow): ProxyRecord {
  return {
    id: row.id,
    url: row.url,
    kind: row.kind as ProxyKind,
    status: row.status as ProxyStatus,
    ...(row.label ? { label: row.label } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.checked_at !== null ? { checkedAt: row.checked_at } : {}),
    ...(row.healthy_at !== null ? { healthyAt: row.healthy_at } : {}),
    ...(row.latency_ms !== null ? { latencyMs: row.latency_ms } : {}),
    ...(row.throughput_bps !== null ? { throughputBps: row.throughput_bps } : {}),
    failureCount: row.failure_count,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.reject_reason ? { rejectReason: row.reject_reason } : {}),
    ...(row.retry_after !== null ? { retryAfter: row.retry_after } : {}),
    ...(row.rate_limited_until !== null ? { rateLimitedUntil: row.rate_limited_until } : {}),
    ...(row.cooldown_reason ? { cooldownReason: row.cooldown_reason as ProxyCooldownReason } : {}),
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.last_minted_at !== null ? { lastMintedAt: row.last_minted_at } : {}),
    ...(row.leased_by ? { leasedBy: row.leased_by } : {}),
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.lease_expires !== null ? { leaseExpires: row.lease_expires } : {}),
  };
}

export interface ProxyLease {
  leaseId: string;
  proxyId: string;
  proxyUrl: string;
  kind: ProxyKind;
  expiresAt: number;
}

export interface ImportSummary {
  imported: number;
  duplicates: number;
  invalid: Array<{ line: string; message: string }>;
}

export interface ProxyPoolDependencies {
  db: DatabaseSync;
  settings: SettingsStore;
  now?: () => number;
}

export class ProxyPoolService {
  private readonly db: DatabaseSync;
  private readonly settings: SettingsStore;
  private readonly now: () => number;

  constructor(dependencies: ProxyPoolDependencies) {
    this.db = dependencies.db;
    this.settings = dependencies.settings;
    this.now = dependencies.now ?? Date.now;
  }

  /** Clears leases left behind by a previous process; nothing survives a restart. */
  resetLeases(): void {
    this.db.prepare("UPDATE proxies SET leased_by = NULL, lease_id = NULL, lease_expires = NULL WHERE lease_id IS NOT NULL").run();
  }

  import(text: string, defaultProtocol: ProxyKind): ImportSummary {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    const summary: ImportSummary = { imported: 0, duplicates: 0, invalid: [] };
    const insert = this.db.prepare(`
      INSERT INTO proxies (id, url, kind, status, created_at, updated_at, failure_count)
      VALUES (?, ?, ?, 'pending', ?, ?, 0)
      ON CONFLICT(url) DO NOTHING
    `);
    immediateTransaction(this.db, () => {
      for (const line of lines) {
        let parsed;
        try {
          parsed = parseProxyImportLine(line, defaultProtocol);
        } catch (error) {
          summary.invalid.push({ line, message: error instanceof Error ? error.message : "Invalid proxy line." });
          continue;
        }
        const at = this.now();
        const result = insert.run(randomUUID(), parsed.url, parsed.kind, at, at);
        if (result.changes > 0) summary.imported += 1;
        else summary.duplicates += 1;
      }
    });
    return summary;
  }

  get(id: string): ProxyRecord | undefined {
    const row = getRow<ProxyRow>(this.db, "SELECT * FROM proxies WHERE id = ?", id);
    return row ? toRecord(row) : undefined;
  }

  require(id: string): ProxyRecord {
    const record = this.get(id);
    if (!record) throw new HttpError(404, "Proxy not found.", "invalid_request_error", "id", "proxy_not_found");
    return record;
  }

  counts(): Record<ProxyStatus, number> {
    const rows = allRows<{ status: string; total: number }>(this.db, "SELECT status, COUNT(*) AS total FROM proxies GROUP BY status");
    const counts: Record<ProxyStatus, number> = { active: 0, pending: 0, unavailable: 0, rejected: 0 };
    for (const row of rows) {
      if (row.status === "active" || row.status === "pending" || row.status === "unavailable" || row.status === "rejected") {
        counts[row.status] = row.total;
      }
    }
    return counts;
  }

  mintableActiveCount(): number {
    return this.listByStatus("active").filter((proxy) => isMintableProxy(proxy.url)).length;
  }

  listByStatus(status: ProxyStatus): ProxyRecord[] {
    return allRows<ProxyRow>(this.db, "SELECT * FROM proxies WHERE status = ? ORDER BY updated_at ASC", status)
      .map(toRecord);
  }

  /** Active proxies not currently held by any minter session and not rate limited. */
  idleActiveCount(): number {
    const now = this.now();
    const row = getRow<{ total: number }>(
      this.db,
      `SELECT COUNT(*) AS total FROM proxies
       WHERE status = 'active' AND (lease_expires IS NULL OR lease_expires < ?)
         AND (rate_limited_until IS NULL OR rate_limited_until < ?)`,
      now,
      now,
    );
    return row?.total ?? 0;
  }

  /** Egress IPs usable for forwarding right now; the affinity pool size. */
  forwardableActiveCount(): number {
    const now = this.now();
    const row = getRow<{ total: number }>(
      this.db,
      "SELECT COUNT(*) AS total FROM proxies WHERE status = 'active' AND (rate_limited_until IS NULL OR rate_limited_until < ?)",
      now,
    );
    return row?.total ?? 0;
  }

  rateLimitedCount(): number {
    const now = this.now();
    const row = getRow<{ total: number }>(
      this.db,
      "SELECT COUNT(*) AS total FROM proxies WHERE status = 'active' AND rate_limited_until >= ?",
      now,
    );
    return row?.total ?? 0;
  }

  /** Active proxies parked for one specific reason. */
  cooldownCount(reason: ProxyCooldownReason): number {
    const now = this.now();
    const row = getRow<{ total: number }>(
      this.db,
      "SELECT COUNT(*) AS total FROM proxies WHERE status = 'active' AND rate_limited_until >= ? AND cooldown_reason = ?",
      now,
      reason,
    );
    return row?.total ?? 0;
  }

  snapshot(options: { status?: ProxyStatus; limit?: number; offset?: number } = {}): { entries: ProxyPublic[]; total: number } {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const now = this.now();
    const where = options.status ? "WHERE p.status = ?" : "";
    const params = options.status ? [options.status] : [];
    const total = getRow<{ total: number }>(this.db, `SELECT COUNT(*) AS total FROM proxies p ${where}`, ...params)?.total ?? 0;
    const rows = allRows<ProxyRow & { available_tickets: number }>(this.db, `
      SELECT p.*, (
        SELECT COUNT(*) FROM tickets t
        WHERE t.proxy_id = p.id AND t.claimed_at IS NULL AND t.expires_at >= ?
      ) AS available_tickets
      FROM proxies p ${where}
      ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END, p.updated_at DESC
      LIMIT ? OFFSET ?
    `, now, ...params, limit, offset);

    const entries = rows.map((row) => {
      const record = toRecord(row);
      return {
        id: record.id,
        maskedUrl: maskProxyUrl(record.url),
        kind: record.kind,
        status: record.status,
        ...(record.label ? { label: record.label } : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.checkedAt ? { checkedAt: record.checkedAt } : {}),
        ...(record.healthyAt ? { healthyAt: record.healthyAt } : {}),
        ...(record.latencyMs !== undefined ? { latencyMs: record.latencyMs } : {}),
        ...(record.throughputBps !== undefined ? { throughputBps: record.throughputBps } : {}),
        failureCount: record.failureCount,
        ...(record.lastError ? { lastError: record.lastError } : {}),
        ...(record.rejectReason ? { rejectReason: record.rejectReason } : {}),
        ...(record.retryAfter ? { retryAfter: record.retryAfter } : {}),
        ...(record.rateLimitedUntil && record.rateLimitedUntil > now ? { rateLimitedUntil: record.rateLimitedUntil } : {}),
        ...(record.rateLimitedUntil && record.rateLimitedUntil > now && record.cooldownReason
          ? { cooldownReason: record.cooldownReason }
          : {}),
        ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
        ...(record.lastMintedAt ? { lastMintedAt: record.lastMintedAt } : {}),
        leased: record.leaseExpires !== undefined && record.leaseExpires > now,
        mintable: isMintableProxy(record.url),
        availableTickets: row.available_tickets,
      } satisfies ProxyPublic;
    });
    return { entries, total };
  }

  /** Proxies eligible for a background probe: pending (or rejected) and past their cooldown. */
  dueForCheck(limit: number): ProxyRecord[] {
    const now = this.now();
    return allRows<ProxyRow>(this.db, `
      SELECT * FROM proxies
      WHERE status IN ('pending', 'rejected') AND (retry_after IS NULL OR retry_after <= ?)
      ORDER BY COALESCE(checked_at, 0) ASC
      LIMIT ?
    `, now, limit).map(toRecord);
  }

  markHealthy(id: string, latencyMs: number, throughputBps?: number): void {
    const now = this.now();
    this.db.prepare(`
      UPDATE proxies
      SET status = 'active', failure_count = 0, last_error = NULL, retry_after = NULL,
          checked_at = ?, healthy_at = ?, latency_ms = ?, throughput_bps = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, Math.max(0, Math.round(latencyMs)), throughputBps && throughputBps > 0 ? Math.round(throughputBps) : null, now, id);
  }

  /** The proxy answered but failed the quality gate; record why and park it. */
  markRejected(id: string, reason: string): void {
    const now = this.now();
    this.db.prepare(`
      UPDATE proxies
      SET status = 'rejected', failure_count = 0, last_error = NULL, retry_after = NULL,
          reject_reason = ?, checked_at = ?, updated_at = ?,
          leased_by = NULL, lease_id = NULL, lease_expires = NULL
      WHERE id = ?
    `).run(reason.slice(0, 500), now, now, id);
  }

  /**
   * Records one failure. Below the threshold the proxy goes back to `pending`
   * with a cooldown; at the threshold it becomes `unavailable` and stops being
   * retried until an operator re-enables it.
   */
  markFailure(id: string, message: string): ProxyStatus | undefined {
    const settings = this.settings.get();
    const now = this.now();
    return immediateTransaction(this.db, () => {
      const row = getRow<{ failure_count: number; url: string }>(this.db, "SELECT failure_count, url FROM proxies WHERE id = ?", id);
      if (!row) return undefined;
      const failureCount = row.failure_count + 1;
      const status: ProxyStatus = failureCount >= settings.proxyFailureThreshold ? "unavailable" : "pending";
      const retryAfter = status === "pending" ? now + settings.proxyRetryCooldownSeconds * 1_000 : null;
      this.db.prepare(`
        UPDATE proxies
        SET status = ?, failure_count = ?, last_error = ?, retry_after = ?, checked_at = ?, updated_at = ?,
            leased_by = NULL, lease_id = NULL, lease_expires = NULL
        WHERE id = ?
      `).run(status, failureCount, message.slice(0, 500), retryAfter, now, now, id);
      void evictProxyDispatcher(row.url);
      return status;
    });
  }

  /** Operator action: clear the failure history and queue the proxy for a probe. */
  reactivate(id: string): void {
    const now = this.now();
    this.db.prepare(`
      UPDATE proxies
      SET status = 'pending', failure_count = 0, last_error = NULL, retry_after = NULL,
          reject_reason = NULL,
          rate_limited_until = NULL, cooldown_reason = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  /**
   * Parks an egress the upstream refused. The proxy stays `active` because
   * nothing is wrong with it as a transport; it simply must not carry traffic
   * until the window passes, so both forwarding and minting skip it. The window
   * only ever extends: a short `Retry-After` must not release an egress already
   * known to be blocked for longer.
   */
  markCooldown(id: string, cooldownMs: number, reason: ProxyCooldownReason): number {
    const now = this.now();
    const until = now + Math.max(0, cooldownMs);
    this.db.prepare(`
      UPDATE proxies SET rate_limited_until = ?, cooldown_reason = ?, updated_at = ?
      WHERE id = ? AND (rate_limited_until IS NULL OR rate_limited_until < ?)
    `).run(until, reason, now, id, until);
    return until;
  }

  /** Stamps the rotation clock so the next request picks a different egress. */
  markUsed(id: string): void {
    this.db.prepare("UPDATE proxies SET last_used_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Stamps the mint rotation clock; used by tests to set up a known ordering. */
  markMinted(id: string, at = this.now()): void {
    this.db.prepare("UPDATE proxies SET last_minted_at = ? WHERE id = ?").run(at, id);
  }

  setLabel(id: string, label: string | undefined): void {
    this.db.prepare("UPDATE proxies SET label = ?, updated_at = ? WHERE id = ?")
      .run(label ?? null, this.now(), id);
  }

  delete(id: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    this.db.prepare("DELETE FROM proxies WHERE id = ?").run(id);
    void evictProxyDispatcher(record.url);
    return true;
  }

  /**
   * Hands an active proxy to one minter session exclusively. Rate-limited egress
   * IPs are skipped: a ticket minted there could not be spent until the window
   * passes, and it would expire first. `priorityIds` come first — a request is
   * already waiting for a ticket on those. Otherwise the egress minted longest
   * ago wins, so tickets accumulate evenly across IPs instead of piling onto
   * whichever proxy a worker happens to be bound to; the live ticket count and
   * health recency only break ties.
   */
  lease(sessionId: string, preferProxyId?: string, priorityIds?: readonly string[]): ProxyLease | { reason: "no_active_proxy" | "all_leased" } {
    const settings = this.settings.get();
    const now = this.now();
    const expiresAt = now + settings.proxyLeaseSeconds * 1_000;
    return immediateTransaction(this.db, () => {
      const activeTotal = getRow<{ total: number }>(this.db, "SELECT COUNT(*) AS total FROM proxies WHERE status = 'active'")?.total ?? 0;
      if (activeTotal === 0) return { reason: "no_active_proxy" as const };

      const claimable = `status = 'active' AND (lease_expires IS NULL OR lease_expires < ?)
        AND (rate_limited_until IS NULL OR rate_limited_until < ?)`;

      // A waiting request beats fairness: without this it would sit until the
      // rotation happened to reach the egress it is pinned to.
      const wanted = priorityIds && priorityIds.length > 0
        ? getRow<ProxyRow>(this.db, `
            SELECT * FROM proxies
            WHERE id IN (${priorityIds.map(() => "?").join(", ")}) AND ${claimable}
            ORDER BY COALESCE(last_minted_at, 0) ASC
            LIMIT 1
          `, ...priorityIds, now, now)
        : undefined;

      // A worker's browser is bound to its proxy, so renewing avoids a restart —
      // but only while that egress is still the fair choice, otherwise one worker
      // would mint on the same IP forever.
      const renewal = wanted ?? (preferProxyId
        ? getRow<ProxyRow>(this.db, `
            SELECT * FROM proxies
            WHERE id = ? AND status = 'active' AND (lease_expires IS NULL OR lease_expires < ? OR leased_by = ?)
              AND (rate_limited_until IS NULL OR rate_limited_until < ?)
              AND NOT EXISTS (
                SELECT 1 FROM proxies other
                WHERE other.status = 'active' AND other.id != proxies.id
                  AND (other.lease_expires IS NULL OR other.lease_expires < ?)
                  AND (other.rate_limited_until IS NULL OR other.rate_limited_until < ?)
                  AND COALESCE(other.last_minted_at, 0) < COALESCE(proxies.last_minted_at, 0)
              )
          `, preferProxyId, now, sessionId, now, now, now)
        : undefined);

      const candidate = renewal ?? getRow<ProxyRow>(this.db, `
        SELECT p.* FROM proxies p
        WHERE p.status = 'active' AND (p.lease_expires IS NULL OR p.lease_expires < ?)
          AND (p.rate_limited_until IS NULL OR p.rate_limited_until < ?)
        ORDER BY COALESCE(p.last_minted_at, 0) ASC, (
          SELECT COUNT(*) FROM tickets t
          WHERE t.proxy_id = p.id AND t.claimed_at IS NULL AND t.expires_at >= ?
        ) ASC, COALESCE(p.healthy_at, 0) DESC
        LIMIT 1
      `, now, now, now);

      if (!candidate) return { reason: "all_leased" as const };
      // Chrome cannot authenticate to a SOCKS proxy, so such an entry can carry
      // forwarded traffic but must never be handed out for minting.
      if (!isMintableProxy(candidate.url)) return { reason: "no_active_proxy" as const };

      const leaseId = randomUUID();
      this.db.prepare("UPDATE proxies SET leased_by = ?, lease_id = ?, lease_expires = ?, last_minted_at = ?, updated_at = ? WHERE id = ?")
        .run(sessionId, leaseId, expiresAt, now, now, candidate.id);
      return {
        leaseId,
        proxyId: candidate.id,
        proxyUrl: candidate.url,
        kind: candidate.kind as ProxyKind,
        expiresAt,
      };
    });
  }

  extendLease(sessionId: string, leaseId: string): number | undefined {
    const settings = this.settings.get();
    const now = this.now();
    const expiresAt = now + settings.proxyLeaseSeconds * 1_000;
    const result = this.db.prepare(`
      UPDATE proxies SET lease_expires = ?, updated_at = ?
      WHERE lease_id = ? AND leased_by = ? AND status = 'active' AND lease_expires >= ?
    `).run(expiresAt, now, leaseId, sessionId, now);
    return result.changes > 0 ? expiresAt : undefined;
  }

  /** Resolves a lease to its proxy, or undefined when it expired or was revoked. */
  resolveLease(sessionId: string, leaseId: string): ProxyRecord | undefined {
    const row = getRow<ProxyRow>(this.db, `
      SELECT * FROM proxies
      WHERE lease_id = ? AND leased_by = ? AND lease_expires >= ?
    `, leaseId, sessionId, this.now());
    return row ? toRecord(row) : undefined;
  }

  releaseLease(sessionId: string, leaseId: string): void {
    this.db.prepare("UPDATE proxies SET leased_by = NULL, lease_id = NULL, lease_expires = NULL WHERE lease_id = ? AND leased_by = ?")
      .run(leaseId, sessionId);
  }

  releaseSessionLeases(sessionId: string): void {
    this.db.prepare("UPDATE proxies SET leased_by = NULL, lease_id = NULL, lease_expires = NULL WHERE leased_by = ?")
      .run(sessionId);
  }

  /** Any active proxy, used for credential-free calls such as the model catalog. */
  anyActive(): ProxyRecord | undefined {
    const now = this.now();
    const row = getRow<ProxyRow>(this.db, `
      SELECT * FROM proxies WHERE status = 'active' AND (rate_limited_until IS NULL OR rate_limited_until < ?)
      ORDER BY COALESCE(latency_ms, 999999) ASC LIMIT 1
    `, now);
    return row ? toRecord(row) : undefined;
  }
}
