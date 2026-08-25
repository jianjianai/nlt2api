import { createHash } from "node:crypto";
import type { PriceDefinition, TokenUsage } from "~/server/utils/analytics-types.ts";

export const DEEPINFRA_MODEL_CATALOG_URL = "https://api.deepinfra.com/models/list";
const NANO_USD_PER_USD = 1_000_000_000;
const NANO_USD_PER_MICRO_USD = 1_000;

export interface DeepInfraModelPrice {
  id: string;
  name: string;
  provider: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion: number | null;
}

export interface CostBreakdown {
  inputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  totalCostMicroUsd: number;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nanoPerTokenFromPerMillion(value: number): number {
  const normalized = Math.round(value * NANO_USD_PER_USD / 1_000_000);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error("The model price exceeds supported integer precision.");
  }
  return normalized;
}

function hashPrice(value: Omit<PriceDefinition, "id" | "contentHash">): string {
  const { fetchedAt: _fetchedAt, verifiedAt: _verifiedAt, effectiveAt: _effectiveAt, ...economicTerms } = value;
  return createHash("sha256").update(JSON.stringify(economicTerms)).digest("hex");
}

export function deepInfraModelPrice(value: Record<string, unknown>): DeepInfraModelPrice | undefined {
  const id = typeof value.model_name === "string" ? value.model_name.trim() : "";
  const pricing = value.pricing && typeof value.pricing === "object" && !Array.isArray(value.pricing)
    ? value.pricing as Record<string, unknown>
    : {};
  // Complete catalog rates are cents per token. Convert to USD per million.
  const inputCents = nonNegativeFinite(pricing.cents_per_input_token);
  const outputCents = nonNegativeFinite(pricing.cents_per_output_token);
  const cachedRate = pricing.rate_per_input_token_cached === null || pricing.rate_per_input_token_cached === undefined
    ? null
    : nonNegativeFinite(pricing.rate_per_input_token_cached);
  if (!id || inputCents === undefined || outputCents === undefined || cachedRate === undefined) return undefined;
  const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : "DeepInfra";
  const inputPerMillion = Number((inputCents * 10_000).toFixed(12));
  return {
    id,
    name: id,
    provider,
    inputPricePerMillion: inputPerMillion,
    outputPricePerMillion: Number((outputCents * 10_000).toFixed(12)),
    cachedInputPricePerMillion: cachedRate === null ? null : Number((inputPerMillion * cachedRate).toFixed(12)),
  };
}

export function deepInfraPriceDefinition(model: DeepInfraModelPrice, fetchedAt: string): PriceDefinition {
  const value: Omit<PriceDefinition, "id" | "contentHash"> = {
    modelId: model.id,
    provider: model.provider,
    displayName: model.name,
    source: "deepinfra_catalog",
    sourceUrl: DEEPINFRA_MODEL_CATALOG_URL,
    currency: "USD",
    inputNanoUsdPerToken: nanoPerTokenFromPerMillion(model.inputPricePerMillion),
    cachedInputNanoUsdPerToken: model.cachedInputPricePerMillion === null
      ? null
      : nanoPerTokenFromPerMillion(model.cachedInputPricePerMillion),
    outputNanoUsdPerToken: nanoPerTokenFromPerMillion(model.outputPricePerMillion),
    effectiveAt: fetchedAt,
    fetchedAt,
    verifiedAt: fetchedAt,
  };
  return { ...value, contentHash: hashPrice(value) };
}

/**
 * Vendor rows are intentionally exact API IDs only. Portal aliases are never
 * rewritten into these IDs; their own catalog prices remain authoritative.
 */
export function builtinVendorPrices(verifiedAt: string): PriceDefinition[] {
  const rows: Array<Omit<PriceDefinition, "id" | "contentHash">> = [
    {
      modelId: "deepseek-chat",
      provider: "DeepSeek",
      displayName: "DeepSeek Chat",
      source: "vendor_official",
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
      currency: "USD",
      inputNanoUsdPerToken: 440,
      cachedInputNanoUsdPerToken: 14,
      outputNanoUsdPerToken: 1_320,
      effectiveAt: verifiedAt,
      fetchedAt: verifiedAt,
      verifiedAt,
    },
    {
      modelId: "deepseek-reasoner",
      provider: "DeepSeek",
      displayName: "DeepSeek Reasoner",
      source: "vendor_official",
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
      currency: "USD",
      inputNanoUsdPerToken: 1_320,
      cachedInputNanoUsdPerToken: 44,
      outputNanoUsdPerToken: 3_960,
      effectiveAt: verifiedAt,
      fetchedAt: verifiedAt,
      verifiedAt,
    },
  ];
  return rows.map((row) => ({ ...row, contentHash: hashPrice(row) }));
}

function microUsd(tokens: number, nanoUsdPerToken: number): number {
  const result = Math.round(tokens * nanoUsdPerToken / NANO_USD_PER_MICRO_USD);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("The calculated model cost exceeds supported integer precision.");
  }
  return result;
}

export function calculateCost(usage: TokenUsage, price: PriceDefinition): CostBreakdown {
  const cachedTokens = Math.min(usage.promptTokens, usage.cachedPromptTokens);
  const regularInputTokens = usage.promptTokens - cachedTokens;
  const cachedRate = price.cachedInputNanoUsdPerToken ?? price.inputNanoUsdPerToken;
  const inputCostMicroUsd = microUsd(regularInputTokens, price.inputNanoUsdPerToken);
  const cachedInputCostMicroUsd = microUsd(cachedTokens, cachedRate);
  const outputCostMicroUsd = microUsd(usage.completionTokens, price.outputNanoUsdPerToken);
  return {
    inputCostMicroUsd,
    cachedInputCostMicroUsd,
    outputCostMicroUsd,
    totalCostMicroUsd: inputCostMicroUsd + cachedInputCostMicroUsd + outputCostMicroUsd,
  };
}
