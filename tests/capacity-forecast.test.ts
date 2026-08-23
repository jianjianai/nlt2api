import assert from "node:assert/strict";
import test from "node:test";
import {
  denseMinutes,
  forecastDemand,
  percentile,
  recommendCapacity,
  recommendCapacityPortfolio,
  stabilizeCapacityRecommendation,
} from "../server/utils/capacity-forecast.ts";

const minute = 60_000;
const now = 60 * minute;
const stableMinutes = Array.from({ length: 60 }, (_, index) => ({ at: (index + 1) * minute, demand: 20 }));

test("percentile and EWMA demand remain deterministic", () => {
  assert.equal(percentile([9, 1, 5, 3], 0.95), 9);
  const forecast = forecastDemand(stableMinutes, now, 0.2);
  assert.equal(forecast.rawRpm, 20);
  assert.equal(forecast.rpm, 24);
  assert.equal(forecast.sampleMinutes, 60);
});

test("sparse minute history fills zeros only inside the observed window", () => {
  const sparse = [{ at: 1 * minute, demand: 10 }, { at: 5 * minute, demand: 20 }];
  assert.deepEqual(denseMinutes(sparse, 5 * minute), [
    { at: 1 * minute, demand: 10 },
    { at: 2 * minute, demand: 0 },
    { at: 3 * minute, demand: 0 },
    { at: 4 * minute, demand: 0 },
    { at: 5 * minute, demand: 20 },
  ]);
  assert.equal(forecastDemand(sparse, 5 * minute).sampleMinutes, 5);
});

test("capacity recommendation requires three pressure or recovery observations", () => {
  const base = {
    model: "m1",
    forecastRpm: 30,
    effectiveCapacityRpm: 10,
    utilization: 3,
    recommendedAccounts: 2,
    bindingConstraint: "account_rpm" as const,
    confidence: "high" as const,
    sampleMinutes: 60,
    p95SampleCount: 120,
    p95DurationMs: 1_000,
    p95Amplification: 1,
    safetyMargin: 0.2,
  };
  assert.equal(stabilizeCapacityRecommendation(base, []).recommendedAccounts, 0);
  assert.equal(stabilizeCapacityRecommendation(base, [{ recommendedAccounts: 2 }, { recommendedAccounts: 2 }]).recommendedAccounts, 2);
  const recovered = { ...base, recommendedAccounts: 0 };
  assert.equal(stabilizeCapacityRecommendation(recovered, [{ recommendedAccounts: 2 }, { recommendedAccounts: 0 }]).recommendedAccounts, 2);
  assert.equal(stabilizeCapacityRecommendation(recovered, [{ recommendedAccounts: 0 }, { recommendedAccounts: 0 }]).recommendedAccounts, 0);
});

test("shared egress saturation recommends egress instead of accounts", () => {
  const recommendation = recommendCapacity({
    model: "m1",
    minutes: stableMinutes.map((entry) => ({ ...entry, demand: 50 })),
    durationsMs: Array.from({ length: 120 }, () => 10_000),
    amplifications: Array.from({ length: 120 }, () => 1),
    accounts: ["a", "b"].map((id) => ({
      id,
      models: ["m1"],
      accountRpm: 100,
      egressId: "shared",
      egressRpm: 30,
      modelConcurrency: { m1: 10 },
      healthy: true,
    })),
    now,
  });
  assert.equal(recommendation.bindingConstraint, "shared_egress_rpm");
  assert.equal(recommendation.recommendedAccounts, 0);
  assert.equal(recommendation.effectiveCapacityRpm, 30);
  assert.equal(recommendation.confidence, "high");
});

test("portfolio capacity allocates one shared account RPM only once across models", () => {
  const account = {
    id: "shared-account",
    models: ["m1", "m2"],
    accountRpm: 20,
    egressId: "direct",
    egressRpm: null,
    modelConcurrency: { m1: 20, m2: 20 },
    healthy: true,
  };
  const portfolio = recommendCapacityPortfolio(["m1", "m2"].map((model) => ({
    model,
    minutes: stableMinutes.map((entry) => ({ ...entry, demand: 15 })),
    durationsMs: Array.from({ length: 120 }, () => 1_000),
    amplifications: Array.from({ length: 120 }, () => 1),
    accounts: [account],
    now,
  })));
  const allocated = portfolio.recommendations.reduce((total, item) => total + item.effectiveCapacityRpm, 0);
  assert.equal(allocated, 20);
  assert.equal(portfolio.totalRecommendedAccounts, 1);
  assert.equal(portfolio.topRecommendation?.recommendedAccounts, 1);
  assert.ok(["m1", "m2"].includes(portfolio.topRecommendation?.model ?? ""));
});

test("portfolio feasibility adds enough low-RPM shared templates", () => {
  const account = {
    id: "shared-account",
    models: ["m1", "m2"],
    accountRpm: 20,
    egressId: "direct",
    egressRpm: null,
    modelConcurrency: { m1: 20, m2: 20 },
    healthy: true,
  };
  const portfolio = recommendCapacityPortfolio(["m1", "m2"].map((model) => ({
    model,
    minutes: stableMinutes.map((entry) => ({ ...entry, demand: 25 })),
    durationsMs: Array.from({ length: 120 }, () => 1_000),
    amplifications: Array.from({ length: 120 }, () => 1),
    accounts: [account],
    now,
  })));
  assert.equal(portfolio.totalRecommendedAccounts, 2);
  assert.equal(portfolio.topRecommendation?.recommendedAccounts, 2);
});

test("portfolio feasibility does not merge non-overlapping model templates", () => {
  const accounts = ["m1", "m2"].map((model) => ({
    id: `${model}-account`,
    models: [model],
    accountRpm: 10,
    egressId: `${model}-direct`,
    egressRpm: null,
    modelConcurrency: { [model]: 20 },
    healthy: true,
  }));
  const portfolio = recommendCapacityPortfolio(["m1", "m2"].map((model) => ({
    model,
    minutes: stableMinutes.map((entry) => ({ ...entry, demand: 15 })),
    durationsMs: Array.from({ length: 120 }, () => 1_000),
    amplifications: Array.from({ length: 120 }, () => 1),
    accounts,
    now,
  })));
  assert.equal(portfolio.totalRecommendedAccounts, 2);
  assert.equal(portfolio.topRecommendation?.recommendedAccounts, 2);
});

test("low sample forecasts do not claim an account count", () => {
  const recommendation = recommendCapacity({
    model: "m1",
    minutes: stableMinutes.slice(-5),
    durationsMs: [10_000, 12_000],
    amplifications: [1],
    accounts: [{
      id: "a",
      models: ["m1"],
      accountRpm: 10,
      egressId: "direct",
      egressRpm: null,
      modelConcurrency: { m1: 1 },
      healthy: true,
    }],
    now,
  });
  assert.equal(recommendation.confidence, "low");
  assert.equal(recommendation.bindingConstraint, "insufficient_samples");
  assert.equal(recommendation.recommendedAccounts, 0);
});
