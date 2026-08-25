import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalyticsDatabase } from "../server/utils/analytics-database.ts";
import { UsageAnalyticsService } from "../server/utils/usage-analytics.ts";

async function withAnalytics<T>(
  run: (service: UsageAnalyticsService, database: AnalyticsDatabase) => Promise<T>,
  loadCatalogModels: () => Promise<Record<string, unknown>[]> = async () => [{
    id: "test-model",
    metadata: { pricing: { input_tokens: 0.001 * 1_000, output_tokens: 0.002 * 1_000, cache_read_tokens: 0.0001 * 1_000 } },
  }],
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "deepinfra-analytics-test-"));
  const database = new AnalyticsDatabase(join(dir, "analytics.sqlite"));
  const service = new UsageAnalyticsService(database, loadCatalogModels);
  try {
    await service.initialize();
    return await run(service, database);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("analytics migrations reopen with WAL and preserve price versions", async () => {
  await withAnalytics(async (service, database) => {
    assert.equal(database.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode, "wal");
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM schema_migrations")?.count, 6);
    assert.ok(service.priceFor("test-model"));
    await service.close();
    database.connection();
    assert.ok(service.priceFor("test-model"));
  });
});

test("same-price catalog refresh keeps immutable price rows and advances sync state", async () => {
  await withAnalytics(async (service, database) => {
    const before = database.get<Record<string, unknown>>("SELECT * FROM price_versions WHERE model_id = 'test-model'")!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.refreshPrices(true);
    const after = database.get<Record<string, unknown>>("SELECT * FROM price_versions WHERE model_id = 'test-model'")!;
    const sync = database.get<{ status: string; checked_at: string }>("SELECT status, checked_at FROM catalog_sync WHERE source = 'deepinfra_catalog'")!;
    assert.deepEqual(after, before);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM price_versions WHERE model_id = 'test-model'")?.count, 1);
    assert.equal(sync.status, "ok");
    assert.ok(Date.parse(sync.checked_at) >= Date.parse(String(before.fetched_at)));
  });
});

test("catalog price A to B to A reactivates the original immutable version", async () => {
  let promptPrice = 0.001;
  await withAnalytics(async (service, database) => {
    const first = service.priceFor("test-model")!;
    promptPrice = 0.003;
    await service.refreshPrices(true);
    const second = service.priceFor("test-model")!;
    promptPrice = 0.001;
    await service.refreshPrices(true);
    const third = service.priceFor("test-model")!;
    assert.notEqual(second.id, first.id);
    assert.equal(third.id, first.id);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM price_versions WHERE model_id = 'test-model'")?.count, 2);
  }, async () => [{
    id: "test-model",
    metadata: { pricing: { input_tokens: promptPrice * 1_000, output_tokens: 0.002 * 1_000, cache_read_tokens: 0.0001 * 1_000 } },
  }]);
});

test("forecast snapshots upsert once per model and minute", async () => {
  await withAnalytics(async (service, database) => {
    const settings = {
      recordMessages: false,
      scheduler: {
        accountModelConcurrency: 5,
        accountRpm: 20,
        proxyRpm: 30,
        directEgressLimitEnabled: false,
        directEgressRpm: 30,
        stickyTtlSeconds: 1_800,
        queueTimeoutSeconds: 0,
        maxQueueSize: 0,
      },
      proxyPool: {
        autoAssignOnAccountCreate: false,
        autoRotateOnTransportError: false,
        retryCurrentRequestAfterRotation: true,
        directFallbackWhenExhausted: false,
        defaultImportProtocol: "http" as const,
        healthCheckTimeoutSeconds: 10,
        errorRetryCooldownSeconds: 300,
      },
    };
    const runtime = {
      inFlight: 0,
      modelInFlight: {},
      requestsLastMinute: 0,
      modelCooldownUntil: {},
      consecutiveFailures: 0,
      cooldownUntil: 0,
    };
    const account = {
      id: "a",
      label: "A",
      email: "a@example.com",
      password: "secret",
      enabled: true,
      weight: 1,
      proxy: null,
      groupIds: [],
      models: ["test-model"],
      hasSession: true,
      sessionExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runtime,
    };
    service.recordSchedulerEvent({ type: "demand", at: Date.now(), model: "test-model" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.overview([account], settings, 0);
    await service.overview([account], settings, 0);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM forecast_snapshots WHERE model = 'test-model'")?.count, 1);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM forecast_snapshots WHERE model = '__portfolio__'")?.count, 1);
  });
});

test("missing attempt usage is explicitly unpriced and excluded from cost", async () => {
  await withAnalytics(async (service, database) => {
    const tracker = service.beginExecution("/v1/chat/completions", "test-model");
    const attempt = tracker.startAttempt({ type: "initial", model: "test-model", now: 1_000 });
    tracker.finishAttempt(attempt, { status: 502, outcome: "failure", now: 2_000 });
    await tracker.settle({ status: 502, outcome: "failure", now: 3_000 });
    const execution = database.get<Record<string, unknown>>("SELECT * FROM executions")!;
    assert.equal(execution.priced, 0);
    assert.equal(execution.usage_missing, 1);
    assert.equal(execution.total_cost_micro_usd, 0);
    assert.equal(execution.price_version_id, null);
    const totals = service.query("1970-01-01T00:00:00.000Z", "1970-01-02T00:00:00.000Z", { granularity: "hour", sort: "cost", direction: "desc" });
    assert.equal(totals.unpricedRequests, 1);
    assert.equal(totals.pricedRequests, 0);
    assert.equal(totals.totalCostMicroUsd, 0);
  });
});

test("one execution settles every attempt exactly once with frozen cost", async () => {
  await withAnalytics(async (service, database) => {
    const tracker = service.beginExecution("/v1/chat/completions", "test-model");
    const first = tracker.startAttempt({ type: "initial", model: "test-model", accountId: "a", now: 1_000 });
    tracker.finishAttempt(first, {
      status: 200,
      outcome: "success",
      now: 2_000,
      usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500, prompt_tokens_details: { cached_tokens: 400 } },
    });
    const repair = tracker.startAttempt({ type: "repair", model: "test-model", accountId: "a", now: 2_000 });
    tracker.finishAttempt(repair, {
      status: 200,
      outcome: "success",
      now: 2_500,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 0 } },
    });
    await tracker.settle({ status: 200, outcome: "success", now: 3_000 });
    await tracker.settle({ status: 500, outcome: "failure", now: 4_000 });

    const execution = database.get<Record<string, unknown>>("SELECT * FROM executions");
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM executions")?.count, 1);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM execution_attempts")?.count, 2);
    assert.equal(execution?.prompt_tokens, 1_100);
    assert.equal(execution?.cached_prompt_tokens, 400);
    assert.equal(execution?.completion_tokens, 550);
    assert.equal(execution?.total_cost_micro_usd, 1_840);
    assert.equal(execution?.priced, 1);
  });
});

test("authoritative API billing overrides catalog estimates and persists energy", async () => {
  await withAnalytics(async (service, database) => {
    const tracker = service.beginExecution("/v1/chat/completions", "test-model");
    const attempt = tracker.startAttempt({
      type: "initial",
      model: "test-model",
      accountId: "api-account",
      billingAuthoritative: true,
      now: 1_000,
    });
    tracker.finishAttempt(attempt, {
      status: 200,
      outcome: "success",
      now: 2_000,
      usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 },
      billing: {
        energy: { energy_kwh: 0.000012, energy_kwh_charged: 0.0000078 },
        cost: { request_cost_usd: 0.000078, accounting_method: "energy" },
        serviceTier: "flex",
      },
    });
    await tracker.settle({ status: 200, outcome: "success", now: 3_000 });
    const execution = database.get<Record<string, unknown>>("SELECT * FROM executions")!;
    const storedAttempt = database.get<Record<string, unknown>>("SELECT * FROM execution_attempts")!;
    assert.equal(execution.cost_source, "upstream_billed");
    assert.equal(execution.total_cost_micro_usd, 78);
    assert.equal(execution.input_cost_micro_usd, 0);
    assert.equal(execution.output_cost_micro_usd, 0);
    assert.equal(execution.energy_consumed_nano_kwh, 12_000);
    assert.equal(execution.energy_charged_nano_kwh, 7_800);
    assert.equal(storedAttempt.service_tier, "flex");
    assert.equal(storedAttempt.accounting_method, "energy");
    const totals = service.query("1970-01-01T00:00:00.000Z", "1970-01-02T00:00:00.000Z", { granularity: "hour", sort: "cost", direction: "desc" });
    assert.equal(totals.totalCostMicroUsd, 78);
    assert.equal(totals.energyConsumedNanoKwh, 12_000);
    assert.equal(totals.models[0]?.upstreamBilledRequests, 1);
  });
});

test("compensation retry preserves the price frozen in its settlement payload", async () => {
  await withAnalytics(async (service, database) => {
    const frozenPrice = service.priceFor("test-model")!;
    const settlement = {
      id: "frozen-execution",
      endpoint: "/v1/chat/completions" as const,
      model: "test-model",
      startedAt: "1970-01-01T00:00:01.000Z",
      completedAt: "1970-01-01T00:00:02.000Z",
      durationMs: 1_000,
      status: 200,
      outcome: "success" as const,
      attempts: [],
      usage: { promptTokens: 1_000, cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 1_000, missing: false },
      price: frozenPrice,
      inputCostMicroUsd: 1_000,
      cachedInputCostMicroUsd: 0,
      outputCostMicroUsd: 0,
      totalCostMicroUsd: 1_000,
      priced: true,
      payloadHash: "frozen-hash",
    };
    database.run(`INSERT INTO analytics_failures (execution_id, payload_json, attempts, next_retry_at, last_error, created_at)
      VALUES (?, ?, 0, ?, 'busy', ?)`, settlement.id, JSON.stringify(settlement), new Date(0).toISOString(), new Date(0).toISOString());
    database.run(`INSERT INTO price_versions (
      model_id, provider, display_name, source, source_url, currency,
      input_nano_usd_per_token, cached_input_nano_usd_per_token, output_nano_usd_per_token,
      effective_at, fetched_at, verified_at, content_hash
    ) VALUES ('test-model', 'Test Provider', 'Test Model V2', 'deepinfra_catalog', 'https://api.deepinfra.com/v1/openai/models', 'USD',
      9000, 900, 18000, ?, ?, ?, 'different-price-version')`,
    new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const newer = database.get<{ id: number }>("SELECT id FROM price_versions WHERE content_hash = 'different-price-version'")!;
    assert.notEqual(newer.id, frozenPrice.id);
    database.run("UPDATE active_prices SET price_version_id = ?, activated_at = ? WHERE model_id = 'test-model'", newer.id, new Date().toISOString());
    await service.retryFailures();
    const execution = database.get<Record<string, unknown>>("SELECT * FROM executions WHERE id = 'frozen-execution'")!;
    assert.equal(execution.price_version_id, frozenPrice.id);
    assert.equal(execution.total_cost_micro_usd, 1_000);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM analytics_failures")?.count, 0);
  });
});

test("cleanup preview token binds bucket content as well as row counts", async () => {
  await withAnalytics(async (service, database) => {
    service.recordSchedulerEvent({ type: "demand", at: 1_000, model: "test-model" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const preview = service.previewCleanup("2025-01-01T00:00:00.000Z");
    database.run("UPDATE minute_buckets SET demand = demand + 1 WHERE model = 'test-model'");
    assert.throws(() => service.cleanup(preview.token), /changed after preview/);
  });
});

test("cleanup deletes detail while preserving daily and monthly totals", async () => {
  await withAnalytics(async (service, database) => {
    const tracker = service.beginExecution("/v1/responses", "test-model");
    const attempt = tracker.startAttempt({ type: "initial", model: "test-model", now: 1_000 });
    tracker.finishAttempt(attempt, {
      status: 200,
      outcome: "success",
      now: 2_000,
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    await tracker.settle({ status: 200, outcome: "success", now: 3_000 });
    const before = service.query("1970-01-01T00:00:00.000Z", "1970-01-02T00:00:00.000Z", { granularity: "hour", sort: "cost", direction: "desc" });
    const preview = service.previewCleanup("2025-01-01T00:00:00.000Z");
    const deleted = service.cleanup(preview.token);
    assert.deepEqual(deleted, { executions: 1, attempts: 1, minuteBuckets: 1 });
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM executions")?.count, 0);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM daily_model_totals")?.count, 1);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM monthly_model_totals")?.count, 1);
    assert.equal(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM cleanup_audit")?.count, 1);
    const after = service.query("1970-01-01T00:00:00.000Z", "1970-01-02T00:00:00.000Z", { granularity: "hour", sort: "cost", direction: "desc" });
    assert.deepEqual({ ...after, series: [] }, { ...before, series: [] });
  });
});
