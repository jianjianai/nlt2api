import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { getProxyConfig } from "~/server/utils/config.ts";

const DATABASE_FILE = "usage-analytics.sqlite";
const SCHEMA_VERSION = 6;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS price_versions (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('vendor_official', 'deepinfra_catalog', 'legacy_catalog')),
  source_url TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  input_nano_usd_per_token INTEGER NOT NULL CHECK (input_nano_usd_per_token >= 0),
  cached_input_nano_usd_per_token INTEGER CHECK (cached_input_nano_usd_per_token >= 0),
  output_nano_usd_per_token INTEGER NOT NULL CHECK (output_nano_usd_per_token >= 0),
  effective_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_price_versions_model ON price_versions(model_id, effective_at DESC);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  status INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  upstream_attempts INTEGER NOT NULL CHECK (upstream_attempts >= 0),
  prompt_tokens INTEGER NOT NULL CHECK (prompt_tokens >= 0),
  cached_prompt_tokens INTEGER NOT NULL CHECK (cached_prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL CHECK (completion_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  usage_missing INTEGER NOT NULL CHECK (usage_missing IN (0, 1)),
  price_version_id INTEGER REFERENCES price_versions(id),
  input_cost_micro_usd INTEGER NOT NULL CHECK (input_cost_micro_usd >= 0),
  cached_input_cost_micro_usd INTEGER NOT NULL CHECK (cached_input_cost_micro_usd >= 0),
  output_cost_micro_usd INTEGER NOT NULL CHECK (output_cost_micro_usd >= 0),
  total_cost_micro_usd INTEGER NOT NULL CHECK (total_cost_micro_usd >= 0),
  priced INTEGER NOT NULL CHECK (priced IN (0, 1)),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_executions_completed ON executions(completed_at);
CREATE INDEX IF NOT EXISTS idx_executions_model_completed ON executions(model, completed_at);
CREATE TABLE IF NOT EXISTS execution_attempts (
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  model TEXT NOT NULL,
  account_id TEXT,
  egress_hash TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  status INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL CHECK (prompt_tokens >= 0),
  cached_prompt_tokens INTEGER NOT NULL CHECK (cached_prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL CHECK (completion_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  usage_missing INTEGER NOT NULL CHECK (usage_missing IN (0, 1)),
  PRIMARY KEY (execution_id, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS minute_buckets (
  minute TEXT NOT NULL,
  model TEXT NOT NULL,
  demand INTEGER NOT NULL DEFAULT 0,
  admitted INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  upstream_attempts INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  duration_samples_json TEXT NOT NULL DEFAULT '[]',
  amplification_samples_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (minute, model)
) STRICT;
CREATE TABLE IF NOT EXISTS daily_model_totals (
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  client_requests INTEGER NOT NULL,
  upstream_attempts INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  cached_prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_cost_micro_usd INTEGER NOT NULL,
  unpriced_requests INTEGER NOT NULL,
  PRIMARY KEY (day, model)
) STRICT;
CREATE TABLE IF NOT EXISTS monthly_model_totals (
  month TEXT NOT NULL,
  model TEXT NOT NULL,
  client_requests INTEGER NOT NULL,
  upstream_attempts INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  cached_prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_cost_micro_usd INTEGER NOT NULL,
  unpriced_requests INTEGER NOT NULL,
  PRIMARY KEY (month, model)
) STRICT;
CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  model TEXT NOT NULL,
  formula_version INTEGER NOT NULL,
  forecast_rpm REAL NOT NULL,
  effective_capacity_rpm REAL NOT NULL,
  utilization REAL NOT NULL,
  recommended_accounts INTEGER NOT NULL,
  binding_constraint TEXT NOT NULL,
  confidence TEXT NOT NULL,
  sample_minutes INTEGER NOT NULL,
  p95_sample_count INTEGER NOT NULL,
  safety_margin REAL NOT NULL,
  evidence_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_forecast_model_at ON forecast_snapshots(model, at DESC);
CREATE TABLE IF NOT EXISTS analytics_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  execution_days INTEGER CHECK (execution_days IS NULL OR execution_days >= 1),
  minute_days INTEGER CHECK (minute_days IS NULL OR minute_days >= 1),
  ledger_started_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS analytics_failures (
  execution_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL,
  last_error TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS cleanup_audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  classes_json TEXT NOT NULL,
  deleted_executions INTEGER NOT NULL,
  deleted_attempts INTEGER NOT NULL,
  deleted_minute_buckets INTEGER NOT NULL,
  aggregate_checksum_before TEXT NOT NULL,
  aggregate_checksum_after TEXT NOT NULL
) STRICT;
`;

export class AnalyticsDatabase {
  private database: DatabaseSync | undefined;

  constructor(private readonly explicitPath?: string) {}

  get path(): string {
    return this.explicitPath ?? join(getProxyConfig().dataDir, DATABASE_FILE);
  }

  connection(): DatabaseSync {
    if (this.database) return this.database;
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate(database);
    const now = new Date().toISOString();
    database.prepare(`INSERT OR IGNORE INTO analytics_settings (id, execution_days, minute_days, ledger_started_at)
      VALUES (1, NULL, NULL, ?)`).run(now);
    this.database = database;
    return database;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.connection();
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation(database);
      database.exec("COMMIT");
      return value;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  get<T extends Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.connection().prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.connection().prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.connection().prepare(sql).run(...params);
  }

  private migrate(database: DatabaseSync): void {
    database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    const current = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
    if ((current.version ?? 0) < 1) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(MIGRATION_1);
        database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    if ((current.version ?? 0) < 2) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_model_minute ON forecast_snapshots(model, substr(at, 1, 16))");
        database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    if ((current.version ?? 0) < 3) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`CREATE TABLE IF NOT EXISTS catalog_sync (
          source TEXT PRIMARY KEY,
          checked_at TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT
        ) STRICT`);
        database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    if ((current.version ?? 0) < 4) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`CREATE TABLE IF NOT EXISTS active_prices (
          model_id TEXT PRIMARY KEY,
          price_version_id INTEGER NOT NULL REFERENCES price_versions(id),
          activated_at TEXT NOT NULL
        ) STRICT;
        ALTER TABLE daily_model_totals ADD COLUMN input_cost_micro_usd INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE daily_model_totals ADD COLUMN cached_input_cost_micro_usd INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE daily_model_totals ADD COLUMN output_cost_micro_usd INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE daily_model_totals ADD COLUMN unpriced_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monthly_model_totals ADD COLUMN input_cost_micro_usd INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monthly_model_totals ADD COLUMN cached_input_cost_micro_usd INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monthly_model_totals ADD COLUMN output_cost_micro_usd INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monthly_model_totals ADD COLUMN unpriced_tokens INTEGER NOT NULL DEFAULT 0;
        INSERT OR IGNORE INTO active_prices (model_id, price_version_id, activated_at)
        SELECT model_id, id, verified_at FROM price_versions p
        WHERE id = (
          SELECT candidate.id FROM price_versions candidate
          WHERE candidate.model_id = p.model_id
          ORDER BY CASE candidate.source WHEN 'vendor_official' THEN 0 ELSE 1 END,
            candidate.effective_at DESC, candidate.id DESC LIMIT 1
        )`);
        database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    if ((current.version ?? 0) < 5) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`ALTER TABLE executions ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'catalog_estimate';
        ALTER TABLE executions ADD COLUMN energy_consumed_nano_kwh INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE executions ADD COLUMN energy_charged_nano_kwh INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE execution_attempts ADD COLUMN billing_authoritative INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE execution_attempts ADD COLUMN energy_consumed_nano_kwh INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE execution_attempts ADD COLUMN energy_charged_nano_kwh INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE execution_attempts ADD COLUMN upstream_cost_micro_usd INTEGER;
        ALTER TABLE execution_attempts ADD COLUMN service_tier TEXT;
        ALTER TABLE execution_attempts ADD COLUMN accounting_method TEXT;
        ALTER TABLE daily_model_totals ADD COLUMN energy_consumed_nano_kwh INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE daily_model_totals ADD COLUMN energy_charged_nano_kwh INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE daily_model_totals ADD COLUMN upstream_billed_requests INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monthly_model_totals ADD COLUMN energy_consumed_nano_kwh INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monthly_model_totals ADD COLUMN energy_charged_nano_kwh INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monthly_model_totals ADD COLUMN upstream_billed_requests INTEGER NOT NULL DEFAULT 0;`);
        database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(5, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    if ((current.version ?? 0) < 6) {
      database.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
      try {
        database.exec(`CREATE TABLE price_versions_v6 (
          id INTEGER PRIMARY KEY,
          model_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          display_name TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('vendor_official', 'deepinfra_catalog', 'legacy_catalog')),
          source_url TEXT NOT NULL,
          currency TEXT NOT NULL CHECK (currency = 'USD'),
          input_nano_usd_per_token INTEGER NOT NULL CHECK (input_nano_usd_per_token >= 0),
          cached_input_nano_usd_per_token INTEGER CHECK (cached_input_nano_usd_per_token >= 0),
          output_nano_usd_per_token INTEGER NOT NULL CHECK (output_nano_usd_per_token >= 0),
          effective_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          content_hash TEXT NOT NULL UNIQUE
        ) STRICT;
        INSERT INTO price_versions_v6 (
          id, model_id, provider, display_name, source, source_url, currency,
          input_nano_usd_per_token, cached_input_nano_usd_per_token, output_nano_usd_per_token,
          effective_at, fetched_at, verified_at, content_hash
        ) SELECT
          id, model_id, provider, display_name,
          CASE source WHEN 'portal_catalog' THEN 'legacy_catalog' ELSE source END,
          source_url, currency, input_nano_usd_per_token, cached_input_nano_usd_per_token,
          output_nano_usd_per_token, effective_at, fetched_at, verified_at, content_hash
        FROM price_versions;
        DROP TABLE price_versions;
        ALTER TABLE price_versions_v6 RENAME TO price_versions;
        CREATE INDEX idx_price_versions_model ON price_versions(model_id, effective_at DESC);
        DELETE FROM catalog_sync WHERE source = 'portal_catalog';`);
        database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(6, new Date().toISOString());
        database.exec("COMMIT; PRAGMA foreign_keys=ON");
      } catch (error) {
        database.exec("ROLLBACK; PRAGMA foreign_keys=ON");
        throw error;
      }
    }
    if ((current.version ?? 0) > SCHEMA_VERSION) {
      throw new Error("The analytics database schema is newer than this application release.");
    }
  }
}

export const analyticsDatabase = new AnalyticsDatabase();
