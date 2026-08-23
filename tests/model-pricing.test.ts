import assert from "node:assert/strict";
import test from "node:test";
import { calculateCost, portalModelPrice, portalPriceDefinition } from "../server/utils/model-pricing.ts";

const fetchedAt = "2026-08-23T00:00:00.000Z";

test("portal prices require exact valid numeric fields", () => {
  const parsed = portalModelPrice({
    id: "kimi-k3-fast",
    name: "Kimi K3 Fast",
    provider: "Moonshot",
    prompt_price_per_1k: 0.003,
    completion_price_per_1k: 0.015,
    cached_input_price_per_1k: 0.0003,
  });
  assert.deepEqual(parsed, {
    id: "kimi-k3-fast",
    name: "Kimi K3 Fast",
    provider: "Moonshot",
    promptPricePer1k: 0.003,
    completionPricePer1k: 0.015,
    cachedInputPricePer1k: 0.0003,
  });
  assert.equal(portalModelPrice({ id: "bad", prompt_price_per_1k: -1, completion_price_per_1k: 1 }), undefined);
});

test("cached prompt tokens are not charged again at the regular input rate", () => {
  const model = portalModelPrice({
    id: "model-1",
    name: "Model 1",
    provider: "Provider",
    prompt_price_per_1k: 0.001,
    completion_price_per_1k: 0.002,
    cached_input_price_per_1k: 0.0001,
  })!;
  const price = portalPriceDefinition(model, fetchedAt);
  const cost = calculateCost({
    promptTokens: 1_000,
    cachedPromptTokens: 400,
    completionTokens: 500,
    reasoningTokens: 100,
    totalTokens: 1_500,
    missing: false,
  }, price);
  assert.deepEqual(cost, {
    inputCostMicroUsd: 600,
    cachedInputCostMicroUsd: 40,
    outputCostMicroUsd: 1_000,
    totalCostMicroUsd: 1_640,
  });
});

test("identical economic portal prices keep a stable content hash across refreshes", () => {
  const model = portalModelPrice({
    id: "model-1",
    name: "Model 1",
    provider: "Provider",
    prompt_price_per_1k: 0.001,
    completion_price_per_1k: 0.002,
    cached_input_price_per_1k: null,
  })!;
  assert.equal(
    portalPriceDefinition(model, "2026-08-23T00:00:00.000Z").contentHash,
    portalPriceDefinition(model, "2026-08-24T00:00:00.000Z").contentHash,
  );
});
