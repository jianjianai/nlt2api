import type { DatabaseSync } from "node:sqlite";
import { redactProxyUrls } from "~/server/utils/proxy.ts";
import type {
  ErrorLogEntry,
  ErrorLogKind,
  ErrorLogStatus,
  ErrorLogSummary,
} from "~/server/utils/types.ts";

/** Longest message kept; anything longer is truncated at the boundary. */
const MAX_MESSAGE_LENGTH = 500;
/** Oldest entry kept; this bounds the table regardless of traffic. */
const DEFAULT_RETENTION_DAYS = 7;
/** Absolute cap; the prune loop also trims by row count as a safety net. */
const MAX_ROWS = 2_000;

interface ErrorLogRow {
  id: number;
  at: number;
  kind: string;
  status: string;
  message: string;
  session_id: string | null;
  proxy_id: string | null;
  agent_id: string | null;
  attempt: number | null;
}

export interface ErrorLogEntryInput {
  at: number;
  kind: ErrorLogKind;
  status: ErrorLogStatus;
  message: string;
  sessionId?: string;
  proxyId?: string;
  agentId?: string;
  attempt?: number;
}

export interface ErrorLogListOptions {
  kind?: ErrorLogKind;
  status?: ErrorLogStatus;
  sessionId?: string;
  proxyId?: string;
  limit?: number;
  offset?: number;
}

function toEntry(row: ErrorLogRow): ErrorLogEntry {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as ErrorLogKind,
    status: row.status as ErrorLogStatus,
    message: row.message,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.proxy_id ? { proxyId: row.proxy_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.attempt !== null ? { attempt: row.attempt } : {}),
  };
}

/**
 * Append-only error journal. Every subsystem reports failures here instead of
 * overwriting a "last error" column, so the admin console can show what happened
 * and when. Messages are redacted at the boundary so no proxy credential can
 * reach the table, and the prune loop bounds the table by both age and size.
 */
export class ErrorLogService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, options: { now?: () => number } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
  }

  record(input: ErrorLogEntryInput): void {
    const message = redactProxyUrls(input.message).slice(0, MAX_MESSAGE_LENGTH);
    this.db.prepare(`
      INSERT INTO error_logs (at, kind, status, message, session_id, proxy_id, agent_id, attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.at,
      input.kind,
      input.status,
      message,
      input.sessionId ?? null,
      input.proxyId ?? null,
      input.agentId ?? null,
      input.attempt ?? null,
    );
  }

  list(options: ErrorLogListOptions = {}): { entries: ErrorLogEntry[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.kind) {
      where.push("kind = ?");
      params.push(options.kind);
    }
    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.sessionId) {
      where.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (options.proxyId) {
      where.push("proxy_id = ?");
      params.push(options.proxyId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM error_logs ${clause}`).get(...params) as { total: number };
    const rows = this.db.prepare(`
      SELECT * FROM error_logs ${clause}
      ORDER BY at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown as ErrorLogRow[];
    return {
      entries: rows.map(toEntry),
      total: Number(total.total ?? 0),
    };
  }

  summary(): ErrorLogSummary {
    const rows = this.db.prepare("SELECT kind, status, COUNT(*) AS total FROM error_logs GROUP BY kind, status").all() as unknown as Array<{ kind: string; status: string; total: number }>;
    const grouped: Record<ErrorLogKind, Record<ErrorLogStatus, number>> = {
      minter: { failed: 0, rejected: 0 },
      forward: { failed: 0, rejected: 0 },
    };
    for (const row of rows) {
      if (row.kind in grouped) {
        const statuses = grouped[row.kind as ErrorLogKind];
        if (row.status in statuses) statuses[row.status as ErrorLogStatus] += Number(row.total ?? 0);
      }
    }
    return grouped;
  }

  /** Removes entries beyond the retention window and trims over the row cap. */
  prune(retentionDays = DEFAULT_RETENTION_DAYS): number {
    const cutoff = this.now() - retentionDays * 86_400_000;
    const aged = this.db.prepare("DELETE FROM error_logs WHERE at < ?").run(cutoff).changes;
    const overflow = this.db.prepare(`
      DELETE FROM error_logs WHERE id NOT IN (
        SELECT id FROM error_logs ORDER BY id DESC LIMIT ?
      )
    `).run(MAX_ROWS).changes;
    return Number(aged) + Number(overflow);
  }

  clear(options: { all?: boolean; olderThanDays?: number } = {}): number {
    if (options.all) return Number(this.db.prepare("DELETE FROM error_logs").run().changes);
    const days = Math.min(Math.max(options.olderThanDays ?? 1, 1), DEFAULT_RETENTION_DAYS + 1);
    const cutoff = this.now() - days * 86_400_000;
    return Number(this.db.prepare("DELETE FROM error_logs WHERE at < ?").run(cutoff).changes);
  }
}