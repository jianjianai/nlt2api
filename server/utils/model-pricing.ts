import { createHash } from "node:crypto";
import type { PriceDefinition, TokenUsage } from "~/server/utils/analytics-types.ts";

export const PORTAL_MODEL_CATALOG_URL = "https://portal.neuralwatt.com/api/models";
const NANO_USD_PER_USD = 1_000_000_000;
const NANO_USD_PER_MICRO_USD = 1_000;

export interface PortalModelPrice {
  id: string;
  name: string;
  provider: string;
  promptPricePer1k: number;
  completionPricePer1k: number;
  cachedInputPricePer1k: number | null;
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

function nanoPerTokenFromPer1k(value: number): number {
  const normalized = Math.round(value * NANO_USD_PER_USD / 1_000);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error("The model price exceeds supported integer precision.");
  }
  return normalized;
}

function hashPrice(value: Omit<PriceDefinition, "id" | "contentHash">): string {
  const { fetchedAt: _fetchedAt, verifiedAt: _verifiedAt, effectiveAt: _effectiveAt, ...economicTerms } = value;
  return createHash("sha256").update(JSON.stringify(economicTerms)).digest("hex");
}

export function portalModelPrice(value: Record<string, unknown>): PortalModelPrice | undefined {
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : id;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "Unknown";
  const prompt = nonNegativeFinite(value.prompt_price_per_1k);
  const completion = nonNegativeFinite(value.completion_price_per_1k);
  const cached = value.cached_input_price_per_1k === null
    ? null
    : nonNegativeFinite(value.cached_input_price_per_1k);
  if (!id || prompt === undefined || completion === undefined || cached === undefined) return undefined;
  return {
    id,
    name: name || id,
    provider: provider || "Unknown",
    promptPricePer1k: prompt,
    completionPricePer1k: completion,
    cachedInputPricePer1k: cached,
  };
}

export function portalPriceDefinition(model: PortalModelPrice, fetchedAt: string): PriceDefinition {
  const value: Omit<PriceDefinition, "id" | "contentHash"> = {
    modelId: model.id,
    provider: model.provider,
    displayName: model.name,
    source: "portal_catalog",
    sourceUrl: PORTAL_MODEL_CATALOG_URL,
    currency: "USD",
    inputNanoUsdPerToken: nanoPerTokenFromPer1k(model.promptPricePer1k),
    cachedInputNanoUsdPerToken: model.cachedInputPricePer1k === null
      ? null
      : nanoPerTokenFromPer1k(model.cachedInputPricePer1k),
    outputNanoUsdPerToken: nanoPerTokenFromPer1k(model.completionPricePer1k),
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
