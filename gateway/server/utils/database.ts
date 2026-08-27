import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getGatewayConfig } from "~/server/utils/config.ts";

const DATABASE_FILE = "gateway.db";

const MIGRATIONS: Array<{ version: number; up: (db: DatabaseSync) => void }> = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE proxies (
          id             TEXT PRIMARY KEY,
          url            TEXT NOT NULL UNIQUE,
          kind           TEXT NOT NULL,
          status         TEXT NOT NULL,
          label          TEXT,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          checked_at     INTEGER,
          healthy_at     INTEGER,
          latency_ms     INTEGER,
          failure_count  INTEGER NOT NULL DEFAULT 0,
          last_error     TEXT,
          retry_after    INTEGER,
          leased_by      TEXT,
          lease_id       TEXT,
          lease_expires  INTEGER
        );
        CREATE INDEX proxies_status ON proxies (status, retry_after);
        CREATE INDEX proxies_lease ON proxies (lease_expires);

        CREATE TABLE tickets (
          id          TEXT PRIMARY KEY,
          proxy_id    TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
          token       TEXT NOT NULL,
          source      TEXT NOT NULL,
          user_agent  TEXT,
          minted_at   INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          claimed_at  INTEGER,
          minter_id   TEXT
        );
        CREATE INDEX tickets_available ON tickets (claimed_at, expires_at);
        CREATE INDEX tickets_proxy ON tickets (proxy_id);

        CREATE TABLE minter_sessions (
          id              TEXT PRIMARY KEY,
          agent_id        TEXT NOT NULL,
          label           TEXT,
          version         TEXT NOT NULL,
          platform        TEXT NOT NULL,
          concurrency     INTEGER NOT NULL DEFAULT 1,
          remote_addr     TEXT,
          connected_at    INTEGER NOT NULL,
          last_seen_at    INTEGER NOT NULL,
          disconnected_at INTEGER,
          minted_count    INTEGER NOT NULL DEFAULT 0,
          failed_count    INTEGER NOT NULL DEFAULT 0,
          last_error      TEXT
        );
        CREATE INDEX minter_sessions_online ON minter_sessions (disconnected_at, last_seen_at);
        CREATE INDEX minter_sessions_agent ON minter_sessions (agent_id);

        CREATE TABLE mint_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          at         INTEGER NOT NULL,
          outcome    TEXT NOT NULL,
          session_id TEXT,
          reason     TEXT
        );
        CREATE INDEX mint_events_at ON mint_events (at);

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        ALTER TABLE proxies ADD COLUMN rate_limited_until INTEGER;
        ALTER TABLE proxies ADD COLUMN last_used_at INTEGER;
        CREATE INDEX proxies_rotation ON proxies (status, last_used_at);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        ALTER TABLE proxies ADD COLUMN last_minted_at INTEGER;
        ALTER TABLE proxies ADD COLUMN cooldown_reason TEXT;
        CREATE INDEX proxies_mint_rotation ON proxies (status, last_minted_at);
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        ALTER TABLE proxies ADD COLUMN throughput_bps INTEGER;
        ALTER TABLE proxies ADD COLUMN reject_reason TEXT;
      `);
    },
  },
];

function applyMigrations(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as unknown as Array<{ version: number }>)
      .map((row) => row.version),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL keeps the background checkers from blocking request-path reads, and the
  // busy timeout absorbs the brief write contention between them.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  return db;
}

let instance: DatabaseSync | undefined;

export function gatewayDatabase(): DatabaseSync {
  if (instance) return instance;
  const { dataDir } = getGatewayConfig();
  mkdirSync(dataDir, { recursive: true });
  instance = openDatabase(join(dataDir, DATABASE_FILE));
  return instance;
}

/** In-memory database for tests; every call yields an isolated, migrated instance. */
export function createInMemoryDatabase(): DatabaseSync {
  return openDatabase(":memory:");
}

export function closeGatewayDatabase(): void {
  instance?.close();
  instance = undefined;
}

/**
 * Runs `body` inside an exclusive write transaction. BEGIN IMMEDIATE takes the
 * write lock up front, which is what makes the lease and ticket claim paths
 * compare-and-set correctly instead of two callers reading the same row.
 */
export function immediateTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * node:sqlite types every column as SQLOutputValue, so row shapes are asserted
 * at the query boundary. These helpers keep that single unchecked cast in one
 * place instead of scattering it across every call site.
 */
export function allRows<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function getRow<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
