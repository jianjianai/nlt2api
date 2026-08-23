import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import analyticsHandler from "../server/api/admin/analytics.get.ts";
import cleanupHandler from "../server/api/admin/analytics/cleanup.post.ts";
import cleanupPreviewHandler from "../server/api/admin/analytics/cleanup/preview.post.ts";
import retentionHandler from "../server/api/admin/analytics/retention.patch.ts";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { usageAnalytics } from "../server/utils/usage-analytics.ts";

type TestEvent = { req: Request; context: Record<string, unknown> };
type TestHandler = (event: TestEvent) => Response | Promise<Response>;

function request(path: string, init: RequestInit = {}, token = "test-admin"): TestEvent {
  return {
    req: new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-admin-token": token } : {}),
        ...(init.headers ?? {}),
      },
    }),
    context: {},
  };
}

async function call(handler: unknown, event: TestEvent): Promise<Response> {
  return (handler as TestHandler)(event);
}

async function withAnalyticsApi<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "neuralwatt-analytics-api-test-"));
  const previousDir = process.env.NEURALWATT_DATA_DIR;
  const previousToken = process.env.NEURALWATT_ADMIN_TOKEN;
  process.env.NEURALWATT_DATA_DIR = dir;
  process.env.NEURALWATT_ADMIN_TOKEN = "test-admin";
  resetProxyConfigForTests();
  await usageAnalytics.resetForTests();
  try {
    return await run();
  } finally {
    await usageAnalytics.resetForTests();
    if (previousDir === undefined) delete process.env.NEURALWATT_DATA_DIR;
    else process.env.NEURALWATT_DATA_DIR = previousDir;
    if (previousToken === undefined) delete process.env.NEURALWATT_ADMIN_TOKEN;
    else process.env.NEURALWATT_ADMIN_TOKEN = previousToken;
    resetProxyConfigForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

test("analytics routes require administrator authentication", async () => {
  await withAnalyticsApi(async () => {
    const response = await call(analyticsHandler, request("/api/admin/analytics", {}, ""));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "invalid_admin_token");
  });
});

test("analytics query validates bounded ranges", async () => {
  await withAnalyticsApi(async () => {
    const invalid = await call(analyticsHandler, request("/api/admin/analytics?from=invalid&to=invalid"));
    assert.equal(invalid.status, 400);
    const from = new Date("2024-01-01T00:00:00.000Z").toISOString();
    const to = new Date("2026-01-02T00:00:00.000Z").toISOString();
    const tooWide = await call(analyticsHandler, request(`/api/admin/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
    assert.equal(tooWide.status, 400);
  });
});

test("analytics query treats the end timestamp as exclusive", async () => {
  await withAnalyticsApi(async () => {
    const database = (await import("../server/utils/analytics-database.ts")).analyticsDatabase;
    database.run(`INSERT INTO daily_model_totals (
      day, model, client_requests, upstream_attempts, prompt_tokens, cached_prompt_tokens,
      completion_tokens, total_cost_micro_usd, unpriced_requests, input_cost_micro_usd,
      cached_input_cost_micro_usd, output_cost_micro_usd, unpriced_tokens
    ) VALUES ('2025-08-23', 'm1', 1, 1, 10, 0, 5, 15, 0, 10, 0, 5, 0)`);
    database.run(`INSERT INTO daily_model_totals (
      day, model, client_requests, upstream_attempts, prompt_tokens, cached_prompt_tokens,
      completion_tokens, total_cost_micro_usd, unpriced_requests, input_cost_micro_usd,
      cached_input_cost_micro_usd, output_cost_micro_usd, unpriced_tokens
    ) VALUES ('2025-08-24', 'm1', 1, 1, 20, 0, 10, 30, 0, 20, 0, 10, 0)`);
    const from = encodeURIComponent("2025-08-23T00:00:00.000Z");
    const to = encodeURIComponent("2025-08-24T00:00:00.000Z");
    const response = await call(analyticsHandler, request(`/api/admin/analytics?from=${from}&to=${to}&granularity=day`));
    const result = (await response.json()).result;
    assert.equal(result.totalCostMicroUsd, 15);
    assert.equal(result.promptTokens, 10);
  });
});

test("analytics query validates granularity and sort enums", async () => {
  await withAnalyticsApi(async () => {
    const invalidGranularity = await call(analyticsHandler, request("/api/admin/analytics?granularity=week"));
    assert.equal(invalidGranularity.status, 400);
    const invalidSort = await call(analyticsHandler, request("/api/admin/analytics?sort=sql"));
    assert.equal(invalidSort.status, 400);
    const valid = await call(analyticsHandler, request("/api/admin/analytics?granularity=day&sort=tokens&direction=asc"));
    assert.equal(valid.status, 200);
    const result = (await valid.json()).result;
    assert.equal(result.granularity, "day");
    assert.equal(result.sort, "tokens");
    assert.equal(result.direction, "asc");
  });
});

test("retention settings persist permanent and bounded day values", async () => {
  await withAnalyticsApi(async () => {
    const saved = await call(retentionHandler, request("/api/admin/analytics/retention", {
      method: "PATCH",
      body: JSON.stringify({ executionDays: null, minuteDays: 30 }),
    }));
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).retention, { executionDays: null, minuteDays: 30 });

    const invalid = await call(retentionHandler, request("/api/admin/analytics/retention", {
      method: "PATCH",
      body: JSON.stringify({ executionDays: 0, minuteDays: 30 }),
    }));
    assert.equal(invalid.status, 400);
  });
});

test("cleanup requires a current preview token", async () => {
  await withAnalyticsApi(async () => {
    const previewResponse = await call(cleanupPreviewHandler, request("/api/admin/analytics/cleanup/preview", {
      method: "POST",
      body: JSON.stringify({ cutoff: "2025-01-01T00:00:00.000Z" }),
    }));
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).preview as { token: string };

    const cleanupResponse = await call(cleanupHandler, request("/api/admin/analytics/cleanup", {
      method: "POST",
      body: JSON.stringify({ token: preview.token }),
    }));
    assert.equal(cleanupResponse.status, 200);
    assert.deepEqual((await cleanupResponse.json()).deleted, { executions: 0, attempts: 0, minuteBuckets: 0 });

    const replay = await call(cleanupHandler, request("/api/admin/analytics/cleanup", {
      method: "POST",
      body: JSON.stringify({ token: preview.token }),
    }));
    assert.equal(replay.status, 400);
  });
});
