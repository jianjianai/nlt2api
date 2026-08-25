import assert from "node:assert/strict";
import test from "node:test";
import { calculateCost, deepInfraModelPrice, deepInfraPriceDefinition } from "../server/utils/model-pricing.ts";

const fetchedAt = "2026-08-23T00:00:00.000Z";

function catalogRow(inputCents = 0.000285, outputCents = 0.001425, cachedRate: number | null = 0.1) {
  return {
    model_name: "moonshotai/Kimi-K3",
    pricing: {
      cents_per_input_token: inputCents,
      cents_per_output_token: outputCents,
      rate_per_input_token_cached: cachedRate,
    },
  };
}

test("DeepInfra catalog prices require valid complete-catalog pricing fields", () => {
  const parsed = deepInfraModelPrice(catalogRow());
  assert.deepEqual(parsed, {
    id: "moonshotai/Kimi-K3",
    name: "moonshotai/Kimi-K3",
    provider: "moonshotai",
    inputPricePerMillion: 2.85,
    outputPricePerMillion: 14.25,
    cachedInputPricePerMillion: 0.285,
  });
  assert.equal(deepInfraModelPrice(catalogRow(-1)), undefined);
});

test("DeepInfra per-million prices convert to exact per-token nano USD", () => {
  const price = deepInfraPriceDefinition(deepInfraModelPrice(catalogRow())!, fetchedAt);
  assert.equal(price.inputNanoUsdPerToken, 2_850);
  assert.equal(price.cachedInputNanoUsdPerToken, 285);
  assert.equal(price.outputNanoUsdPerToken, 14_250);
  const cost = calculateCost({
    promptTokens: 1_000,
    cachedPromptTokens: 400,
    completionTokens: 500,
    reasoningTokens: 100,
    totalTokens: 1_500,
    missing: false,
  }, price);
  assert.deepEqual(cost, {
    inputCostMicroUsd: 1_710,
    cachedInputCostMicroUsd: 114,
    outputCostMicroUsd: 7_125,
    totalCostMicroUsd: 8_949,
  });
});

test("identical DeepInfra economic terms keep a stable hash across refreshes", () => {
  const model = deepInfraModelPrice(catalogRow(0.0001, 0.0002, null))!;
  assert.equal(
    deepInfraPriceDefinition(model, "2026-08-23T00:00:00.000Z").contentHash,
    deepInfraPriceDefinition(model, "2026-08-24T00:00:00.000Z").contentHash,
  );
});
