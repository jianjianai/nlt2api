import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AnalyticsDatabase, analyticsDatabase } from "~/server/utils/analytics-database.ts";
import type {
  AnalyticsOverview,
  AnalyticsQueryOptions,
  AnalyticsQueryResult,
  AnalyticsRetention,
  AnalyticsSeriesPoint,
  AttemptSettlement,
  CapacityRecommendation,
  CleanupPreview,
  ExecutionSettlement,
  ForecastConstraint,
  ModelAnalyticsRow,
  PriceDefinition,
  SchedulerAnalyticsEvent,
  TokenUsage,
} from "~/server/utils/analytics-types.ts";
import {
  recommendCapacityPortfolio,
  stabilizeCapacityRecommendation,
  type CapacityAccount,
  type ModelForecastInput,
  type RecommendationHistoryEntry,
} from "~/server/utils/capacity-forecast.ts";
import { builtinVendorPrices, calculateCost, portalModelPrice, portalPriceDefinition } from "~/server/utils/model-pricing.ts";
import { portalClient } from "~/server/utils/portal-client.ts";
import { egressIdentity } from "~/server/utils/proxy.ts";
import type { ProxySettings, PublicAccount, UpstreamUsage } from "~/server/utils/types.ts";

const PRICE_REFRESH_MS = 24 * 60 * 60 * 1_000;
const MAX_SCHEDULER_EVENTS = 10_000;
const MAX_ANALYTICS_FAILURES = 10_000;
const MAX_BUCKET_SAMPLES = 512;
const CLEANUP_TOKEN_TTL_MS = 10 * 60 * 1_000;

function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function tokenUsage(value: UpstreamUsage | undefined): TokenUsage {
  if (!value) {
    return { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, missing: true };
  }
  const promptTokens = whole(value.prompt_tokens);
  const cachedPromptTokens = Math.min(promptTokens, whole(value.prompt_tokens_details?.cached_tokens));
  const completionTokens = whole(value.completion_tokens);
  const reasoningTokens = whole(value.completion_tokens_details?.reasoning_tokens);
  return {
    promptTokens,
    cachedPromptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens: whole(value.total_tokens) || promptTokens + completionTokens,
    missing: false,
  };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    cachedPromptTokens: left.cachedPromptTokens + right.cachedPromptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    missing: left.missing || right.missing,
  };
}

const EMPTY_USAGE: TokenUsage = Object.freeze({
  promptTokens: 0,
  cachedPromptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  missing: false,
});

export interface UsageAttemptHandle {
  sequence: number;
  type: AttemptSettlement["type"];
  model: string;
  accountId?: string;
  egressHash?: string;
  startedAtMs: number;
  finished: boolean;
}

export class UsageExecutionTracker {
  readonly id = randomUUID();
  readonly startedAtMs: number;
  private readonly attempts: AttemptSettlement[] = [];
  private sequence = 0;
  private settled = false;

  constructor(
    private readonly service: UsageAnalyticsService,
    readonly endpoint: ExecutionSettlement["endpoint"],
    readonly model: string,
    now = Date.now(),
  ) {
    this.startedAtMs = now;
  }

  startAttempt(input: {
    type: AttemptSettlement["type"];
    model: string;
    accountId?: string;
    egressHash?: string;
    now?: number;
  }): UsageAttemptHandle {
    return {
      sequence: ++this.sequence,
      type: input.type,
      model: input.model,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.egressHash ? { egressHash: input.egressHash } : {}),
      startedAtMs: input.now ?? Date.now(),
      finished: false,
    };
  }

  finishAttempt(
    attempt: UsageAttemptHandle | undefined,
    input: { status: number; outcome: AttemptSettlement["outcome"]; usage?: UpstreamUsage; now?: number },
  ): void {
    if (!attempt || attempt.finished) return;
    attempt.finished = true;
    const completedAtMs = input.now ?? Date.now();
    this.attempts.push({
      sequence: attempt.sequence,
      type: attempt.type,
      model: attempt.model,
      ...(attempt.accountId ? { accountId: attempt.accountId } : {}),
      ...(attempt.egressHash ? { egressHash: attempt.egressHash } : {}),
      startedAt: new Date(attempt.startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - attempt.startedAtMs),
      status: input.status,
      outcome: input.outcome,
      usage: tokenUsage(input.usage),
    });
  }

  async settle(input: { status: number; outcome: ExecutionSettlement["outcome"]; now?: number }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    const completedAtMs = input.now ?? Date.now();
    await this.service.settle({
      id: this.id,
      endpoint: this.endpoint,
      model: this.model,
      startedAt: new Date(this.startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - this.startedAtMs),
      status: input.status,
      outcome: input.outcome,
      attempts: [...this.attempts].sort((a, b) => a.sequence - b.sequence),
    });
  }
}

interface UnpricedExecution {
  id: string;
  endpoint: ExecutionSettlement["endpoint"];
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: number;
  outcome: ExecutionSettlement["outcome"];
  attempts: AttemptSettlement[];
}

interface CleanupPreviewState extends CleanupPreview {
  selectionHash: string;
}

interface BucketRow extends Record<string, unknown> {
  minute: string;
  model: string;
  demand: number;
  admitted: number;
  queued: number;
  rejected: number;
  succeeded: number;
  failed: number;
  upstream_attempts: number;
  prompt_tokens: number;
  cached_prompt_tokens: number;
  completion_tokens: number;
  total_cost_micro_usd: number;
  duration_samples_json: string;
  amplification_samples_json: string;
  constraints_json: string;
}

function parseNumbers(raw: string): number[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
  } catch {
    return [];
  }
}

function parseConstraints(raw: string): Record<string, number> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, number> : {};
  } catch {
    return {};
  }
}

function minuteKey(timestamp: number | string): string {
  const date = new Date(timestamp);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function priceFromRow(row: Record<string, unknown>): PriceDefinition {
  return {
    id: Number(row.id),
    modelId: String(row.model_id),
    provider: String(row.provider),
    displayName: String(row.display_name),
    source: row.source === "vendor_official" ? "vendor_official" : "portal_catalog",
    sourceUrl: String(row.source_url),
    currency: "USD",
    inputNanoUsdPerToken: Number(row.input_nano_usd_per_token),
    cachedInputNanoUsdPerToken: row.cached_input_nano_usd_per_token === null ? null : Number(row.cached_input_nano_usd_per_token),
    outputNanoUsdPerToken: Number(row.output_nano_usd_per_token),
    effectiveAt: String(row.effective_at),
    fetchedAt: String(row.fetched_at),
    verifiedAt: String(row.verified_at),
    contentHash: String(row.content_hash),
  };
}

export class UsageAnalyticsService {
  private healthError: string | undefined;
  private priceError: string | undefined;
  private refreshPromise: Promise<void> | undefined;
  private schedulerEvents: SchedulerAnalyticsEvent[] = [];
  private flushScheduled = false;
  private droppedEvents = 0;
  private droppedSettlements = 0;
  private demandTimesByModel = new Map<string, number[]>();
  private admissionTimesByModel = new Map<string, number[]>();
  private readonly cleanupPreviews = new Map<string, CleanupPreviewState>();
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(
    private readonly database = analyticsDatabase,
    private readonly loadPortalModels: () => Promise<Record<string, unknown>[]> = () => portalClient.listModels(),
  ) {}

  beginExecution(endpoint: ExecutionSettlement["endpoint"], model: string): UsageExecutionTracker {
    this.recordSchedulerEvent({ type: "demand", at: Date.now(), model });
    return new UsageExecutionTracker(this, endpoint, model);
  }

  async initialize(): Promise<void> {
    try {
      this.database.connection();
      this.database.transaction((database) => {
        for (const price of builtinVendorPrices(new Date().toISOString())) this.insertPrice(database, price);
      });
      this.enforceRetention();
      await this.retryFailures();
      this.healthError = undefined;
    } catch (error) {
      this.healthError = error instanceof Error ? error.message : "Analytics initialization failed.";
      return;
    }
    await this.refreshPricesIfDue().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pendingWrites]);
    this.database.close();
  }

  async resetForTests(): Promise<void> {
    await this.close();
    this.healthError = undefined;
    this.priceError = undefined;
    this.refreshPromise = undefined;
    this.schedulerEvents = [];
    this.flushScheduled = false;
    this.droppedEvents = 0;
    this.droppedSettlements = 0;
    this.demandTimesByModel.clear();
    this.admissionTimesByModel.clear();
    this.cleanupPreviews.clear();
  }

  async refreshPrices(force = false): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performPriceRefresh(force)
      .then(() => {
        this.priceError = undefined;
      })
      .catch((error) => {
        this.priceError = error instanceof Error ? error.message : "Price refresh failed.";
        try {
          this.database.run(`INSERT INTO catalog_sync (source, checked_at, status, error)
            VALUES ('portal_catalog', COALESCE((SELECT checked_at FROM catalog_sync WHERE source = 'portal_catalog'), ?), 'error', ?)
            ON CONFLICT(source) DO UPDATE SET status = excluded.status, error = excluded.error`,
          new Date(0).toISOString(), this.priceError.slice(0, 500));
        } catch {
          // The overview still exposes the in-memory price error.
        }
        throw error;
      })
      .finally(() => {
        this.refreshPromise = undefined;
      });
    return this.refreshPromise;
  }

  async refreshPricesIfDue(): Promise<void> {
    const latest = this.database.get<{ checked_at: string; status: string }>("SELECT checked_at, status FROM catalog_sync WHERE source = 'portal_catalog'");
    const due = !latest || latest.status !== "ok" || Date.now() - Date.parse(latest.checked_at) >= PRICE_REFRESH_MS;
    if (due) await this.refreshPrices(false);
  }

  private async performPriceRefresh(force: boolean): Promise<void> {
    const latest = this.database.get<{ checked_at: string; status: string }>("SELECT checked_at, status FROM catalog_sync WHERE source = 'portal_catalog'");
    if (!force && latest?.status === "ok" && Date.now() - Date.parse(latest.checked_at) < PRICE_REFRESH_MS) return;
    const fetchedAt = new Date().toISOString();
    const models = (await this.loadPortalModels()).map(portalModelPrice).filter((model): model is NonNullable<typeof model> => Boolean(model));
    if (models.length === 0) throw new Error("The portal model catalog contained no valid price rows.");
    this.database.transaction((database) => {
      for (const model of models) this.insertPrice(database, portalPriceDefinition(model, fetchedAt));
      database.prepare(`INSERT INTO catalog_sync (source, checked_at, status, error)
        VALUES ('portal_catalog', ?, 'ok', NULL)
        ON CONFLICT(source) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status, error = NULL`).run(fetchedAt);
    });
    this.healthError = undefined;
  }

  private insertPrice(database: DatabaseSync, price: PriceDefinition): number {
    database.prepare(`INSERT OR IGNORE INTO price_versions (
      model_id, provider, display_name, source, source_url, currency,
      input_nano_usd_per_token, cached_input_nano_usd_per_token, output_nano_usd_per_token,
      effective_at, fetched_at, verified_at, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      price.modelId,
      price.provider,
      price.displayName,
      price.source,
      price.sourceUrl,
      price.currency,
      price.inputNanoUsdPerToken,
      price.cachedInputNanoUsdPerToken,
      price.outputNanoUsdPerToken,
      price.effectiveAt,
      price.fetchedAt,
      price.verifiedAt,
      price.contentHash,
    );
    const row = database.prepare("SELECT id FROM price_versions WHERE content_hash = ?").get(price.contentHash) as { id: number };
    const active = database.prepare(`SELECT p.source FROM active_prices active
      JOIN price_versions p ON p.id = active.price_version_id
      WHERE active.model_id = ?`).get(price.modelId) as { source: string } | undefined;
    if (!active || price.source === "vendor_official" || active.source !== "vendor_official") {
      database.prepare(`INSERT INTO active_prices (model_id, price_version_id, activated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET
          price_version_id = excluded.price_version_id,
          activated_at = excluded.activated_at`).run(price.modelId, row.id, price.verifiedAt);
    }
    return row.id;
  }

  priceFor(model: string): PriceDefinition | undefined {
    const row = this.database.get<Record<string, unknown>>(`SELECT price.* FROM active_prices active
      JOIN price_versions price ON price.id = active.price_version_id
      WHERE active.model_id = ?`, model);
    return row ? priceFromRow(row) : undefined;
  }

  settle(input: UnpricedExecution): Promise<void> {
    const pending = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      try {
        this.persistSettlement(input);
        this.healthError = undefined;
      } catch (error) {
        this.healthError = error instanceof Error ? error.message : "Usage settlement failed.";
      }
    });
    this.pendingWrites.add(pending);
    void pending.finally(() => this.pendingWrites.delete(pending));
    return pending;
  }

  private prepareSettlement(input: UnpricedExecution): ExecutionSettlement {
    const usage = input.attempts.reduce((total, attempt) => addTokenUsage(total, attempt.usage), { ...EMPTY_USAGE });
    const price = this.priceFor(input.model);
    const priced = Boolean(price) && !usage.missing;
    const cost = priced && price ? calculateCost(usage, price) : {
      inputCostMicroUsd: 0,
      cachedInputCostMicroUsd: 0,
      outputCostMicroUsd: 0,
      totalCostMicroUsd: 0,
    };
    const normalized = {
      ...input,
      usage,
      priceId: priced ? price?.id ?? null : null,
      cost,
      priced,
    };
    return {
      ...input,
      usage,
      ...(priced && price ? { price } : {}),
      ...cost,
      priced,
      payloadHash: hashPayload(normalized),
    };
  }

  private persistSettlement(input: UnpricedExecution): void {
    const settlement = this.prepareSettlement(input);
    try {
      this.database.transaction((database) => this.insertSettlement(database, settlement));
    } catch (error) {
      this.enqueueFailure(settlement, error instanceof Error ? error.message : "Usage settlement failed.");
      throw error;
    }
  }

  private insertSettlement(database: DatabaseSync, settlement: ExecutionSettlement): void {
    const existing = database.prepare("SELECT payload_hash FROM executions WHERE id = ?").get(settlement.id) as { payload_hash: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== settlement.payloadHash) {
        throw new Error(`Conflicting analytics settlement for execution ${settlement.id}.`);
      }
      return;
    }
    database.prepare(`INSERT INTO executions (
      id, endpoint, model, started_at, completed_at, duration_ms, status, outcome, upstream_attempts,
      prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, usage_missing,
      price_version_id, input_cost_micro_usd, cached_input_cost_micro_usd, output_cost_micro_usd,
      total_cost_micro_usd, priced, payload_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      settlement.id,
      settlement.endpoint,
      settlement.model,
      settlement.startedAt,
      settlement.completedAt,
      settlement.durationMs,
      settlement.status,
      settlement.outcome,
      settlement.attempts.length,
      settlement.usage.promptTokens,
      settlement.usage.cachedPromptTokens,
      settlement.usage.completionTokens,
      settlement.usage.reasoningTokens,
      settlement.usage.totalTokens,
      settlement.usage.missing ? 1 : 0,
      settlement.price?.id ?? null,
      settlement.inputCostMicroUsd,
      settlement.cachedInputCostMicroUsd,
      settlement.outputCostMicroUsd,
      settlement.totalCostMicroUsd,
      settlement.priced ? 1 : 0,
      settlement.payloadHash,
      new Date().toISOString(),
    );
    const insertAttempt = database.prepare(`INSERT INTO execution_attempts (
      execution_id, sequence, type, model, account_id, egress_hash, started_at, completed_at, duration_ms,
      status, outcome, prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, usage_missing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const attempt of settlement.attempts) {
      insertAttempt.run(
        settlement.id,
        attempt.sequence,
        attempt.type,
        attempt.model,
        attempt.accountId ?? null,
        attempt.egressHash ?? null,
        attempt.startedAt,
        attempt.completedAt,
        attempt.durationMs,
        attempt.status,
        attempt.outcome,
        attempt.usage.promptTokens,
        attempt.usage.cachedPromptTokens,
        attempt.usage.completionTokens,
        attempt.usage.reasoningTokens,
        attempt.usage.totalTokens,
        attempt.usage.missing ? 1 : 0,
      );
    }
    this.updateSettlementAggregates(database, settlement);
  }

  private updateSettlementAggregates(database: DatabaseSync, settlement: ExecutionSettlement): void {
    const minute = minuteKey(settlement.completedAt);
    const existing = database.prepare("SELECT * FROM minute_buckets WHERE minute = ? AND model = ?").get(minute, settlement.model) as BucketRow | undefined;
    const durations = parseNumbers(existing?.duration_samples_json ?? "[]");
    const amplifications = [...parseNumbers(existing?.amplification_samples_json ?? "[]"), settlement.attempts.length].slice(-MAX_BUCKET_SAMPLES);
    database.prepare(`INSERT INTO minute_buckets (
      minute, model, demand, admitted, queued, rejected, succeeded, failed, upstream_attempts,
      prompt_tokens, cached_prompt_tokens, completion_tokens, total_cost_micro_usd,
      duration_samples_json, amplification_samples_json, constraints_json
    ) VALUES (?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(minute, model) DO UPDATE SET
      succeeded = succeeded + excluded.succeeded,
      failed = failed + excluded.failed,
      upstream_attempts = upstream_attempts + excluded.upstream_attempts,
      prompt_tokens = prompt_tokens + excluded.prompt_tokens,
      cached_prompt_tokens = cached_prompt_tokens + excluded.cached_prompt_tokens,
      completion_tokens = completion_tokens + excluded.completion_tokens,
      total_cost_micro_usd = total_cost_micro_usd + excluded.total_cost_micro_usd,
      duration_samples_json = excluded.duration_samples_json,
      amplification_samples_json = excluded.amplification_samples_json`).run(
      minute,
      settlement.model,
      settlement.outcome === "success" ? 1 : 0,
      settlement.outcome === "success" ? 0 : 1,
      settlement.attempts.length,
      settlement.usage.promptTokens,
      settlement.usage.cachedPromptTokens,
      settlement.usage.completionTokens,
      settlement.totalCostMicroUsd,
      JSON.stringify(durations),
      JSON.stringify(amplifications),
    );
    for (const [table, period] of [
      ["daily_model_totals", settlement.completedAt.slice(0, 10)],
      ["monthly_model_totals", settlement.completedAt.slice(0, 7)],
    ] as const) {
      const periodColumn = table === "daily_model_totals" ? "day" : "month";
      database.prepare(`INSERT INTO ${table} (
        ${periodColumn}, model, client_requests, upstream_attempts, prompt_tokens, cached_prompt_tokens,
        completion_tokens, total_cost_micro_usd, unpriced_requests, input_cost_micro_usd,
        cached_input_cost_micro_usd, output_cost_micro_usd, unpriced_tokens
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(${periodColumn}, model) DO UPDATE SET
        client_requests = client_requests + 1,
        upstream_attempts = upstream_attempts + excluded.upstream_attempts,
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        cached_prompt_tokens = cached_prompt_tokens + excluded.cached_prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        total_cost_micro_usd = total_cost_micro_usd + excluded.total_cost_micro_usd,
        unpriced_requests = unpriced_requests + excluded.unpriced_requests,
        input_cost_micro_usd = input_cost_micro_usd + excluded.input_cost_micro_usd,
        cached_input_cost_micro_usd = cached_input_cost_micro_usd + excluded.cached_input_cost_micro_usd,
        output_cost_micro_usd = output_cost_micro_usd + excluded.output_cost_micro_usd,
        unpriced_tokens = unpriced_tokens + excluded.unpriced_tokens`).run(
        period,
        settlement.model,
        settlement.attempts.length,
        settlement.usage.promptTokens,
        settlement.usage.cachedPromptTokens,
        settlement.usage.completionTokens,
        settlement.totalCostMicroUsd,
        settlement.priced ? 0 : 1,
        settlement.inputCostMicroUsd,
        settlement.cachedInputCostMicroUsd,
        settlement.outputCostMicroUsd,
        settlement.priced ? 0 : settlement.usage.totalTokens,
      );
    }
  }

  async retryFailures(limit = 50): Promise<void> {
    const rows = this.database.all<{ execution_id: string; payload_json: string; attempts: number }>(`SELECT execution_id, payload_json, attempts
      FROM analytics_failures WHERE next_retry_at <= ? ORDER BY created_at LIMIT ?`, new Date().toISOString(), limit);
    for (const row of rows) {
      try {
        const settlement = JSON.parse(row.payload_json) as ExecutionSettlement;
        this.database.transaction((database) => this.insertSettlement(database, settlement));
        this.database.run("DELETE FROM analytics_failures WHERE execution_id = ?", row.execution_id);
      } catch (error) {
        const attempts = row.attempts + 1;
        const delayMs = Math.min(60 * 60_000, 30_000 * (2 ** Math.min(attempts, 7)));
        this.database.run(`UPDATE analytics_failures SET attempts = ?, next_retry_at = ?, last_error = ?
          WHERE execution_id = ?`, attempts, new Date(Date.now() + delayMs).toISOString(),
        (error instanceof Error ? error.message : "Analytics compensation retry failed.").slice(0, 500), row.execution_id);
      }
    }
  }

  async maintain(): Promise<void> {
    try {
      this.enforceRetention();
      await this.retryFailures();
      await this.refreshPricesIfDue().catch(() => undefined);
      this.healthError = undefined;
    } catch (error) {
      this.healthError = error instanceof Error ? error.message : "Analytics maintenance failed.";
    }
  }

  private enqueueFailure(settlement: ExecutionSettlement, error: string): void {
    try {
      const count = this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_failures")?.count ?? 0;
      if (count >= MAX_ANALYTICS_FAILURES) {
        this.database.run(`DELETE FROM analytics_failures WHERE execution_id IN (
          SELECT execution_id FROM analytics_failures ORDER BY created_at LIMIT 100
        )`);
        this.droppedSettlements += 100;
      }
      this.database.run(`INSERT INTO analytics_failures (execution_id, payload_json, attempts, next_retry_at, last_error, created_at)
        VALUES (?, ?, 0, ?, ?, ?)
        ON CONFLICT(execution_id) DO UPDATE SET last_error = excluded.last_error`,
      settlement.id,
      JSON.stringify(settlement),
      new Date(Date.now() + 30_000).toISOString(),
      error.slice(0, 500),
      new Date().toISOString());
    } catch {
      // Analytics degradation is surfaced in status; the request path stays available.
    }
  }

  recordSchedulerEvent(event: SchedulerAnalyticsEvent): void {
    if (event.type === "demand") {
      const demandTimes = this.demandTimesByModel.get(event.model) ?? [];
      demandTimes.push(event.at);
      this.demandTimesByModel.set(event.model, demandTimes);
    }
    if (event.type === "admitted") {
      const admissionTimes = this.admissionTimesByModel.get(event.model) ?? [];
      admissionTimes.push(event.at);
      this.admissionTimesByModel.set(event.model, admissionTimes);
    }
    if (this.schedulerEvents.length >= MAX_SCHEDULER_EVENTS) {
      this.droppedEvents += 1;
      return;
    }
    this.schedulerEvents.push(event);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flushSchedulerEvents();
    });
  }

  private flushSchedulerEvents(): void {
    const events = this.schedulerEvents.splice(0);
    if (events.length === 0) return;
    try {
      this.database.transaction((database) => {
        for (const event of events) this.updateEventBucket(database, event);
      });
      this.healthError = undefined;
    } catch (error) {
      this.healthError = error instanceof Error ? error.message : "Scheduler analytics flush failed.";
      this.droppedEvents += events.length;
    }
  }

  private updateEventBucket(database: DatabaseSync, event: SchedulerAnalyticsEvent): void {
    const minute = minuteKey(event.at);
    const existing = database.prepare("SELECT * FROM minute_buckets WHERE minute = ? AND model = ?").get(minute, event.model) as BucketRow | undefined;
    const constraints = parseConstraints(existing?.constraints_json ?? "{}");
    if (event.constraint) constraints[event.constraint] = whole(constraints[event.constraint]) + 1;
    const durations = event.type === "released" && event.durationMs !== undefined
      ? [...parseNumbers(existing?.duration_samples_json ?? "[]"), event.durationMs].slice(-MAX_BUCKET_SAMPLES)
      : parseNumbers(existing?.duration_samples_json ?? "[]");
    const demand = event.type === "demand" ? 1 : 0;
    const admitted = event.type === "admitted" ? 1 : 0;
    const queued = event.type === "blocked" ? 1 : 0;
    const rejected = event.type === "rejected" ? 1 : 0;
    database.prepare(`INSERT INTO minute_buckets (
      minute, model, demand, admitted, queued, rejected, succeeded, failed, upstream_attempts,
      prompt_tokens, cached_prompt_tokens, completion_tokens, total_cost_micro_usd,
      duration_samples_json, amplification_samples_json, constraints_json
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, '[]', ?)
    ON CONFLICT(minute, model) DO UPDATE SET
      demand = demand + excluded.demand,
      admitted = admitted + excluded.admitted,
      queued = queued + excluded.queued,
      rejected = rejected + excluded.rejected,
      duration_samples_json = excluded.duration_samples_json,
      constraints_json = excluded.constraints_json`).run(
      minute,
      event.model,
      demand,
      admitted,
      queued,
      rejected,
      JSON.stringify(durations),
      JSON.stringify(constraints),
    );
  }

  async overview(accounts: PublicAccount[], settings: ProxySettings, upstreamRpm: number): Promise<AnalyticsOverview> {
    try {
      this.flushSchedulerEvents();
      const now = Date.now();
      const series = this.series(now - 60 * 60_000, now);
      const clientRpm = this.currentClientRpm(now);
      const totals = this.costTotals(now);
      const modelIds = [...new Set([...this.demandTimesByModel.keys(), ...this.recentExecutionModels(now)])].sort();
      const portfolio = recommendCapacityPortfolio(modelIds.map((model) => this.forecastInput(model, accounts, settings, now)));
      const rawRecommendations = portfolio.recommendations;
      const recommendations = rawRecommendations.map((item) => this.stabilizeRecommendation(item, now));
      const forecastByModel = new Map(recommendations.map((item) => [item.model, item]));
      const models = this.modelRows(now, modelIds).map((row) => {
        const forecast = forecastByModel.get(row.model)!;
        return {
          ...row,
          effectiveCapacityRpm: forecast.effectiveCapacityRpm,
          utilization: forecast.utilization,
          recommendedAccounts: forecast.recommendedAccounts,
          bindingConstraint: forecast.bindingConstraint,
          confidence: forecast.confidence,
        };
      });
      const rawTop = portfolio.topRecommendation;
      const recommendation = rawTop ? this.stabilizeRecommendation(rawTop, now, "__portfolio__") : undefined;
      this.persistForecastSnapshots(rawRecommendations, now);
      if (rawTop) this.persistForecastSnapshots([rawTop], now, "__portfolio__");
      const latestPrice = this.database.get<{ checked_at: string; status: string }>("SELECT checked_at, status FROM catalog_sync WHERE source = 'portal_catalog'");
      const ledger = this.database.get<{ ledger_started_at: string }>("SELECT ledger_started_at FROM analytics_settings WHERE id = 1");
      const pricedTotal = totals.pricedRequests + totals.unpricedRequests;
      const pendingFailures = this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_failures")?.count ?? 0;
      const degraded = Boolean(this.healthError) || pendingFailures > 0 || this.droppedSettlements > 0;
      return {
        health: degraded ? "degraded" : "healthy",
        ...(this.healthError ? { error: this.healthError } : {}),
        ...(ledger ? { ledgerStartedAt: ledger.ledger_started_at } : {}),
        priceStatus: !latestPrice
          ? "unavailable"
          : latestPrice.status !== "ok" || now - Date.parse(latestPrice.checked_at) >= PRICE_REFRESH_MS * 2
            ? "stale"
            : "current",
        ...(latestPrice ? { priceUpdatedAt: latestPrice.checked_at } : {}),
        clientRpm,
        upstreamRpm,
        amplification: clientRpm > 0 ? upstreamRpm / clientRpm : 0,
        utilization: recommendation?.utilization ?? 0,
        trend15m: this.trend15m(series),
        todayCostMicroUsd: totals.today,
        monthCostMicroUsd: totals.month,
        pricedCoverage: pricedTotal > 0 ? totals.pricedRequests / pricedTotal : 1,
        unpricedRequests: totals.unpricedRequests,
        unpricedTokens: totals.unpricedTokens,
        series,
        models,
        ...(recommendation ? { recommendation } : {}),
        anomalies: [
          ...(this.healthError ? ["分析数据库暂时不可用，网关请求不受影响。"] : []),
          ...(pendingFailures > 0 ? [`${pendingFailures} 条计费结算正在补偿重试。`] : []),
          ...(this.droppedSettlements > 0 ? [`${this.droppedSettlements} 条最旧计费补偿因队列达到上限而被淘汰。`] : []),
          ...(this.priceError ? [`价格刷新失败：${this.priceError}`] : []),
          ...(this.droppedEvents > 0 ? [`${this.droppedEvents} 个容量样本因分析队列已满而丢弃。`] : []),
          ...(totals.unpricedRequests > 0 ? [`${totals.unpricedRequests} 个请求缺少有效价格。`] : []),
        ],
      };
    } catch (error) {
      this.healthError = error instanceof Error ? error.message : "Analytics query failed.";
      return this.degradedOverview(this.healthError);
    }
  }

  private stabilizeRecommendation(item: CapacityRecommendation, now: number, historyModel = item.model): CapacityRecommendation {
    const currentMinute = Date.parse(minuteKey(now));
    const historyStart = new Date(currentMinute - 2 * 60_000).toISOString();
    const rows = this.database.all<{ recommended_accounts: number; evidence_json: string }>(`SELECT recommended_accounts, evidence_json
      FROM forecast_snapshots WHERE model = ? AND at >= ? AND at < ? ORDER BY at DESC LIMIT 2`, historyModel, historyStart, minuteKey(now));
    const history: RecommendationHistoryEntry[] = rows.map((row) => {
      let targetModel: string | undefined;
      try {
        const evidence = JSON.parse(row.evidence_json) as { targetModel?: unknown };
        if (typeof evidence.targetModel === "string") targetModel = evidence.targetModel;
      } catch {
        // Legacy snapshot evidence has no target model.
      }
      return { recommendedAccounts: row.recommended_accounts, ...(targetModel ? { targetModel } : {}) };
    });
    return stabilizeCapacityRecommendation(item, history);
  }

  private persistForecastSnapshots(recommendations: CapacityRecommendation[], now: number, overrideModel?: string): void {
    if (recommendations.length === 0) return;
    const at = minuteKey(now);
    this.database.transaction((database) => {
      const statement = database.prepare(`INSERT INTO forecast_snapshots (
        at, model, formula_version, forecast_rpm, effective_capacity_rpm, utilization,
        recommended_accounts, binding_constraint, confidence, sample_minutes,
        p95_sample_count, safety_margin, evidence_json
      ) VALUES (?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model, substr(at, 1, 16)) DO UPDATE SET
        at = excluded.at,
        formula_version = excluded.formula_version,
        forecast_rpm = excluded.forecast_rpm,
        effective_capacity_rpm = excluded.effective_capacity_rpm,
        utilization = excluded.utilization,
        recommended_accounts = excluded.recommended_accounts,
        binding_constraint = excluded.binding_constraint,
        confidence = excluded.confidence,
        sample_minutes = excluded.sample_minutes,
        p95_sample_count = excluded.p95_sample_count,
        safety_margin = excluded.safety_margin,
        evidence_json = excluded.evidence_json`);
      for (const item of recommendations) {
        statement.run(
          at,
          overrideModel ?? item.model,
          item.forecastRpm,
          item.effectiveCapacityRpm,
          item.utilization,
          item.recommendedAccounts,
          item.bindingConstraint,
          item.confidence,
          item.sampleMinutes,
          item.p95SampleCount,
          item.safetyMargin,
          JSON.stringify({
            formula: "ewma-5-15-60-max-flow-v3",
            targetModel: item.model,
            p95DurationMs: item.p95DurationMs,
            p95Amplification: item.p95Amplification,
            timeToThresholdMinutes: item.timeToThresholdMinutes ?? null,
          }),
        );
      }
    });
  }

  private degradedOverview(error: string): AnalyticsOverview {
    return {
      health: "degraded",
      error,
      priceStatus: "unavailable",
      clientRpm: 0,
      upstreamRpm: 0,
      amplification: 0,
      utilization: 0,
      trend15m: 0,
      todayCostMicroUsd: 0,
      monthCostMicroUsd: 0,
      pricedCoverage: 0,
      unpricedRequests: 0,
      unpricedTokens: 0,
      series: [],
      models: [],
      anomalies: ["分析数据暂时不可用，网关请求不受影响。"],
    };
  }

  private currentClientRpm(now: number): number {
    let total = 0;
    for (const [model, times] of this.demandTimesByModel) {
      const active = times.filter((time) => time > now - 60_000);
      this.demandTimesByModel.set(model, active);
      total += active.length;
    }
    return total;
  }

  private series(from: number, to: number, granularity?: AnalyticsQueryOptions["granularity"]): AnalyticsSeriesPoint[] {
    const span = Math.max(0, to - from);
    const bucketSeconds = granularity === "minute"
      ? 60
      : granularity === "5m"
        ? 300
        : granularity === "hour"
          ? 3_600
          : granularity === "day"
            ? 86_400
            : span <= 12 * 60 * 60_000
              ? 60
              : span <= 2 * 24 * 60 * 60_000
                ? 300
                : span <= 30 * 24 * 60 * 60_000
                  ? 3_600
                  : 86_400;
    const rows = this.database.all<Record<string, unknown>>(`SELECT
      datetime(CAST(unixepoch(minute) / ? AS INTEGER) * ?, 'unixepoch') AS minute,
      SUM(demand) AS demand, SUM(admitted) AS admitted, SUM(rejected) AS rejected,
      SUM(succeeded + failed) AS client_requests, SUM(upstream_attempts) AS upstream_attempts,
      SUM(total_cost_micro_usd) AS total_cost_micro_usd
      FROM minute_buckets WHERE minute >= ? AND minute <= ?
      GROUP BY datetime(CAST(unixepoch(minute) / ? AS INTEGER) * ?, 'unixepoch')
      ORDER BY minute LIMIT 1000`, bucketSeconds, bucketSeconds, minuteKey(from), minuteKey(to), bucketSeconds, bucketSeconds);
    return rows.map((row) => {
      const rawMinute = String(row.minute);
      return {
        minute: rawMinute.includes("T") ? rawMinute : `${rawMinute.replace(" ", "T")}Z`,
        clientRequests: Number(row.client_requests),
        upstreamAttempts: Number(row.upstream_attempts),
        demand: Number(row.demand),
        admitted: Number(row.admitted),
        rejected: Number(row.rejected),
        totalCostMicroUsd: Number(row.total_cost_micro_usd),
      };
    });
  }

  private trend15m(series: AnalyticsSeriesPoint[]): number {
    const recent = series.slice(-5).reduce((total, point) => total + point.demand, 0) / 5;
    const baseline = series.slice(-15, -5).reduce((total, point) => total + point.demand, 0) / 10;
    return baseline > 0 ? (recent - baseline) / baseline : 0;
  }

  private costTotals(now: number): { today: number; month: number; pricedRequests: number; unpricedRequests: number; unpricedTokens: number } {
    const day = new Date(now).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const today = this.database.get<Record<string, unknown>>(`SELECT
      COALESCE(SUM(total_cost_micro_usd), 0) AS total_cost_micro_usd,
      COALESCE(SUM(client_requests - unpriced_requests), 0) AS priced_requests,
      COALESCE(SUM(unpriced_requests), 0) AS unpriced_requests,
      COALESCE(SUM(unpriced_tokens), 0) AS unpriced_tokens
      FROM daily_model_totals WHERE day = ?`, day) ?? {};
    const monthTotal = this.database.get<{ total_cost_micro_usd: number }>(`SELECT
      COALESCE(SUM(total_cost_micro_usd), 0) AS total_cost_micro_usd
      FROM monthly_model_totals WHERE month = ?`, month);
    return {
      today: Number(today.total_cost_micro_usd ?? 0),
      month: Number(monthTotal?.total_cost_micro_usd ?? 0),
      pricedRequests: Number(today.priced_requests ?? 0),
      unpricedRequests: Number(today.unpriced_requests ?? 0),
      unpricedTokens: Number(today.unpriced_tokens ?? 0),
    };
  }

  private recentExecutionModels(now: number): string[] {
    const day = new Date(now).toISOString().slice(0, 10);
    return this.database.all<{ model: string }>("SELECT model FROM daily_model_totals WHERE day = ?", day)
      .map((row) => row.model);
  }

  private modelRows(now: number, modelIds: string[]): ModelAnalyticsRow[] {
    const day = new Date(now).toISOString().slice(0, 10);
    const rows = this.database.all<Record<string, unknown>>(`SELECT model, client_requests AS requests,
      upstream_attempts, prompt_tokens, cached_prompt_tokens, completion_tokens,
      total_cost_micro_usd, input_cost_micro_usd, cached_input_cost_micro_usd,
      output_cost_micro_usd, unpriced_requests
      FROM daily_model_totals WHERE day = ? ORDER BY total_cost_micro_usd DESC`, day);
    const byModel = new Map(rows.map((row) => [String(row.model), row]));
    return modelIds.map((model) => {
      const row = byModel.get(model) ?? {};
      const attempts = Number(row.upstream_attempts ?? 0);
      const requests = Number(row.requests ?? 0);
      const price = this.priceFor(model);
      return {
        model,
        clientRpm: this.modelDemandRpm(model, now),
        upstreamRpm: this.modelUpstreamRpm(model, now),
        amplification: requests > 0 ? attempts / requests : 0,
        promptTokens: Number(row.prompt_tokens ?? 0),
        cachedPromptTokens: Number(row.cached_prompt_tokens ?? 0),
        completionTokens: Number(row.completion_tokens ?? 0),
        totalCostMicroUsd: Number(row.total_cost_micro_usd ?? 0),
        inputCostMicroUsd: Number(row.input_cost_micro_usd ?? 0),
        cachedInputCostMicroUsd: Number(row.cached_input_cost_micro_usd ?? 0),
        outputCostMicroUsd: Number(row.output_cost_micro_usd ?? 0),
        unpricedRequests: Number(row.unpriced_requests ?? 0),
        ...(price ? { priceSource: price.source, priceVerifiedAt: price.verifiedAt } : {}),
        p95DurationMs: 0,
        effectiveCapacityRpm: 0,
        utilization: 0,
        recommendedAccounts: 0,
        bindingConstraint: "insufficient_samples" as const,
        confidence: "low" as const,
      };
    });
  }

  private modelDemandRpm(model: string, now: number): number {
    const active = (this.demandTimesByModel.get(model) ?? []).filter((time) => time > now - 60_000);
    this.demandTimesByModel.set(model, active);
    return active.length;
  }

  private modelUpstreamRpm(model: string, now: number): number {
    const active = (this.admissionTimesByModel.get(model) ?? []).filter((time) => time > now - 60_000);
    this.admissionTimesByModel.set(model, active);
    return active.length;
  }

  private capacityAccounts(accounts: PublicAccount[], settings: ProxySettings, model: string, now: number): CapacityAccount[] {
    return accounts.map((account) => {
      const identity = egressIdentity(account.proxy ?? undefined);
      const modelConcurrency = Object.fromEntries(account.models.map((supported) => [supported,
        account.schedulerOverrides?.modelConcurrency?.[supported]
          ?? account.schedulerOverrides?.accountModelConcurrency
          ?? settings.scheduler.accountModelConcurrency]));
      return {
        id: account.id,
        models: account.models,
        accountRpm: account.schedulerOverrides?.accountRpm ?? settings.scheduler.accountRpm,
        egressId: identity.id,
        egressRpm: identity.direct && !settings.scheduler.directEgressLimitEnabled
          ? null
          : identity.direct ? settings.scheduler.directEgressRpm : settings.scheduler.proxyRpm,
        modelConcurrency,
        healthy: account.enabled && account.hasSession && account.runtime.cooldownUntil <= now
          && (account.runtime.modelCooldownUntil[model] ?? 0) <= now,
      };
    });
  }

  private forecastInput(model: string, accounts: PublicAccount[], settings: ProxySettings, now: number): ModelForecastInput {
    const rows = this.database.all<BucketRow>("SELECT * FROM minute_buckets WHERE model = ? AND minute >= ? ORDER BY minute", model, minuteKey(now - 60 * 60_000));
    return {
      model,
      now,
      minutes: rows.map((row) => ({ at: Date.parse(row.minute), demand: row.demand })),
      durationsMs: rows.flatMap((row) => parseNumbers(row.duration_samples_json)),
      amplifications: rows.flatMap((row) => parseNumbers(row.amplification_samples_json)),
      accounts: this.capacityAccounts(accounts, settings, model, now),
    };
  }

  query(from: string, to: string, options: AnalyticsQueryOptions): AnalyticsQueryResult {
    const { model, granularity, sort, direction } = options;
    const rangeMinutes = Math.max(1, (Date.parse(to) - Date.parse(from)) / 60_000);
    const fromDay = from.slice(0, 10);
    const toDay = new Date(Date.parse(to) - 1).toISOString().slice(0, 10);
    const where = model ? "day >= ? AND day <= ? AND model = ?" : "day >= ? AND day <= ?";
    const params = model ? [fromDay, toDay, model] : [fromDay, toDay];
    const total = this.database.get<Record<string, unknown>>(`SELECT
      COALESCE(SUM(total_cost_micro_usd), 0) AS total_cost_micro_usd,
      COALESCE(SUM(input_cost_micro_usd), 0) AS input_cost_micro_usd,
      COALESCE(SUM(cached_input_cost_micro_usd), 0) AS cached_input_cost_micro_usd,
      COALESCE(SUM(output_cost_micro_usd), 0) AS output_cost_micro_usd,
      COALESCE(SUM(client_requests - unpriced_requests), 0) AS priced_requests,
      COALESCE(SUM(unpriced_requests), 0) AS unpriced_requests,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(cached_prompt_tokens), 0) AS cached_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens
      FROM daily_model_totals WHERE ${where}`, ...params) ?? {};
    const rows = this.database.all<Record<string, unknown>>(`SELECT model,
      SUM(client_requests) AS requests, SUM(upstream_attempts) AS upstream_attempts,
      SUM(prompt_tokens) AS prompt_tokens, SUM(cached_prompt_tokens) AS cached_prompt_tokens,
      SUM(completion_tokens) AS completion_tokens, SUM(total_cost_micro_usd) AS total_cost_micro_usd,
      SUM(input_cost_micro_usd) AS input_cost_micro_usd,
      SUM(cached_input_cost_micro_usd) AS cached_input_cost_micro_usd,
      SUM(output_cost_micro_usd) AS output_cost_micro_usd,
      SUM(unpriced_requests) AS unpriced_requests
      FROM daily_model_totals WHERE ${where} GROUP BY model ORDER BY total_cost_micro_usd DESC`, ...params);
    const forecastRows = this.database.all<Record<string, unknown>>(`SELECT snapshot.* FROM forecast_snapshots snapshot
      JOIN (
        SELECT model, MAX(at) AS at FROM forecast_snapshots
        WHERE at >= ? AND at <= ? AND model <> '__portfolio__'
        GROUP BY model
      ) latest ON latest.model = snapshot.model AND latest.at = snapshot.at`, from, to);
    const forecasts = new Map(forecastRows.map((row) => [String(row.model), row]));
    const models: ModelAnalyticsRow[] = rows.map((row) => {
      const requests = Number(row.requests ?? 0);
      const attempts = Number(row.upstream_attempts ?? 0);
      const rowModel = String(row.model);
      const price = this.priceFor(rowModel);
      const forecast = forecasts.get(rowModel);
      return {
        model: rowModel,
        clientRpm: requests / rangeMinutes,
        upstreamRpm: attempts / rangeMinutes,
        amplification: requests > 0 ? attempts / requests : 0,
        promptTokens: Number(row.prompt_tokens ?? 0),
        cachedPromptTokens: Number(row.cached_prompt_tokens ?? 0),
        completionTokens: Number(row.completion_tokens ?? 0),
        totalCostMicroUsd: Number(row.total_cost_micro_usd ?? 0),
        inputCostMicroUsd: Number(row.input_cost_micro_usd ?? 0),
        cachedInputCostMicroUsd: Number(row.cached_input_cost_micro_usd ?? 0),
        outputCostMicroUsd: Number(row.output_cost_micro_usd ?? 0),
        unpricedRequests: Number(row.unpriced_requests ?? 0),
        ...(price ? { priceSource: price.source, priceVerifiedAt: price.verifiedAt } : {}),
        p95DurationMs: 0,
        effectiveCapacityRpm: Number(forecast?.effective_capacity_rpm ?? 0),
        utilization: Number(forecast?.utilization ?? 0),
        recommendedAccounts: Number(forecast?.recommended_accounts ?? 0),
        bindingConstraint: (typeof forecast?.binding_constraint === "string" ? forecast.binding_constraint : "insufficient_samples") as ForecastConstraint,
        confidence: forecast?.confidence === "high" || forecast?.confidence === "medium" ? forecast.confidence : "low",
      };
    });
    const factor = direction === "asc" ? 1 : -1;
    models.sort((left, right) => {
      const leftValue = sort === "utilization"
        ? left.utilization
        : sort === "rpm"
          ? left.clientRpm
          : sort === "tokens"
            ? left.promptTokens + left.completionTokens
            : left.totalCostMicroUsd;
      const rightValue = sort === "utilization"
        ? right.utilization
        : sort === "rpm"
          ? right.clientRpm
          : sort === "tokens"
            ? right.promptTokens + right.completionTokens
            : right.totalCostMicroUsd;
      return (leftValue - rightValue) * factor || left.model.localeCompare(right.model);
    });
    return {
      from,
      to,
      granularity,
      sort,
      direction,
      models,
      series: this.series(Date.parse(from), Date.parse(to), granularity),
      totalCostMicroUsd: Number(total.total_cost_micro_usd ?? 0),
      inputCostMicroUsd: Number(total.input_cost_micro_usd ?? 0),
      cachedInputCostMicroUsd: Number(total.cached_input_cost_micro_usd ?? 0),
      outputCostMicroUsd: Number(total.output_cost_micro_usd ?? 0),
      pricedRequests: Number(total.priced_requests ?? 0),
      unpricedRequests: Number(total.unpriced_requests ?? 0),
      promptTokens: Number(total.prompt_tokens ?? 0),
      cachedPromptTokens: Number(total.cached_prompt_tokens ?? 0),
      completionTokens: Number(total.completion_tokens ?? 0),
    };
  }

  getRetention(): AnalyticsRetention {
    const row = this.database.get<{ execution_days: number | null; minute_days: number | null }>("SELECT execution_days, minute_days FROM analytics_settings WHERE id = 1");
    return { executionDays: row?.execution_days ?? null, minuteDays: row?.minute_days ?? null };
  }

  updateRetention(value: AnalyticsRetention): AnalyticsRetention {
    this.database.run("UPDATE analytics_settings SET execution_days = ?, minute_days = ? WHERE id = 1", value.executionDays, value.minuteDays);
    this.enforceRetention();
    return this.getRetention();
  }

  enforceRetention(now = Date.now()): void {
    const retention = this.getRetention();
    this.database.transaction((database) => {
      if (retention.minuteDays !== null) {
        const cutoff = new Date(now - retention.minuteDays * 24 * 60 * 60_000).toISOString();
        database.prepare("DELETE FROM minute_buckets WHERE minute < ?").run(cutoff);
      }
      if (retention.executionDays !== null) {
        const cutoff = new Date(now - retention.executionDays * 24 * 60 * 60_000).toISOString();
        database.prepare("DELETE FROM executions WHERE completed_at < ?").run(cutoff);
      }
    });
  }

  previewCleanup(cutoff: string): CleanupPreview {
    const parsed = Date.parse(cutoff);
    if (!Number.isFinite(parsed) || parsed >= Date.now()) throw new Error("Cleanup cutoff must be a valid past timestamp.");
    const executions = this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM executions WHERE completed_at < ?", cutoff)?.count ?? 0;
    const attempts = this.database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM execution_attempts
      WHERE execution_id IN (SELECT id FROM executions WHERE completed_at < ?)`, cutoff)?.count ?? 0;
    const minuteBuckets = this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM minute_buckets WHERE minute < ?", cutoff)?.count ?? 0;
    const token = randomUUID();
    const selectionHash = this.cleanupSelectionHash(this.database.connection(), new Date(parsed).toISOString());
    const preview: CleanupPreviewState = {
      token,
      cutoff: new Date(parsed).toISOString(),
      executions,
      attempts,
      minuteBuckets,
      expiresAt: new Date(Date.now() + CLEANUP_TOKEN_TTL_MS).toISOString(),
      selectionHash,
    };
    this.cleanupPreviews.set(token, preview);
    return preview;
  }

  cleanup(token: string): { executions: number; attempts: number; minuteBuckets: number } {
    const preview = this.cleanupPreviews.get(token);
    this.cleanupPreviews.delete(token);
    if (!preview || Date.parse(preview.expiresAt) < Date.now()) throw new Error("Cleanup preview expired; create a new preview.");
    return this.database.transaction((database) => {
      const current = {
        executions: (database.prepare("SELECT COUNT(*) AS count FROM executions WHERE completed_at < ?").get(preview.cutoff) as { count: number }).count,
        attempts: (database.prepare(`SELECT COUNT(*) AS count FROM execution_attempts
          WHERE execution_id IN (SELECT id FROM executions WHERE completed_at < ?)`).get(preview.cutoff) as { count: number }).count,
        minuteBuckets: (database.prepare("SELECT COUNT(*) AS count FROM minute_buckets WHERE minute < ?").get(preview.cutoff) as { count: number }).count,
      };
      const selectionHash = this.cleanupSelectionHash(database, preview.cutoff);
      if (current.executions !== preview.executions || current.attempts !== preview.attempts || current.minuteBuckets !== preview.minuteBuckets
        || selectionHash !== preview.selectionHash) {
        throw new Error("Analytics data changed after preview; create a new cleanup preview.");
      }
      const before = this.aggregateChecksum(database);
      database.prepare("DELETE FROM minute_buckets WHERE minute < ?").run(preview.cutoff);
      database.prepare("DELETE FROM executions WHERE completed_at < ?").run(preview.cutoff);
      const after = this.aggregateChecksum(database);
      if (before !== after) throw new Error("Cleanup changed preserved aggregate totals.");
      database.prepare(`INSERT INTO cleanup_audit (
        at, cutoff, classes_json, deleted_executions, deleted_attempts, deleted_minute_buckets,
        aggregate_checksum_before, aggregate_checksum_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        new Date().toISOString(),
        preview.cutoff,
        JSON.stringify(["executions", "attempts", "minute_buckets"]),
        current.executions,
        current.attempts,
        current.minuteBuckets,
        before,
        after,
      );
      return current;
    });
  }

  private cleanupSelectionHash(database: DatabaseSync, cutoff: string): string {
    const hash = createHash("sha256");
    const executions = database.prepare("SELECT id, payload_hash FROM executions WHERE completed_at < ? ORDER BY id").iterate(cutoff);
    for (const row of executions) hash.update(`e:${String(row.id)}:${String(row.payload_hash)}\n`);
    const buckets = database.prepare(`SELECT minute, model, demand, admitted, queued, rejected, succeeded, failed,
      upstream_attempts, prompt_tokens, cached_prompt_tokens, completion_tokens, total_cost_micro_usd,
      duration_samples_json, amplification_samples_json, constraints_json
      FROM minute_buckets WHERE minute < ? ORDER BY minute, model`).iterate(cutoff);
    for (const row of buckets) hash.update(`m:${JSON.stringify(row)}\n`);
    return hash.digest("hex");
  }

  private aggregateChecksum(database: DatabaseSync): string {
    const rows = database.prepare(`SELECT 'day' AS kind, day AS period, model, client_requests, upstream_attempts,
      prompt_tokens, cached_prompt_tokens, completion_tokens, total_cost_micro_usd, unpriced_requests,
      input_cost_micro_usd, cached_input_cost_micro_usd, output_cost_micro_usd, unpriced_tokens
      FROM daily_model_totals UNION ALL
      SELECT 'month', month, model, client_requests, upstream_attempts, prompt_tokens,
      cached_prompt_tokens, completion_tokens, total_cost_micro_usd, unpriced_requests,
      input_cost_micro_usd, cached_input_cost_micro_usd, output_cost_micro_usd, unpriced_tokens
      FROM monthly_model_totals ORDER BY kind, period, model`).all();
    return hashPayload(rows);
  }
}

export const usageAnalytics = new UsageAnalyticsService();
