export type PriceSource = "vendor_official" | "deepinfra_catalog" | "legacy_catalog" | "upstream_billed";
export type AnalyticsHealthStatus = "healthy" | "degraded";
export type ForecastConstraint =
  | "account_rpm"
  | "model_concurrency"
  | "shared_egress_rpm"
  | "no_healthy_account"
  | "model_cooldown"
  | "account_cooldown"
  | "queue_policy"
  | "insufficient_samples";

export interface TokenUsage {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  missing: boolean;
}

export interface PriceDefinition {
  id?: number;
  modelId: string;
  provider: string;
  displayName: string;
  source: PriceSource;
  sourceUrl: string;
  currency: "USD";
  inputNanoUsdPerToken: number;
  cachedInputNanoUsdPerToken: number | null;
  outputNanoUsdPerToken: number;
  effectiveAt: string;
  fetchedAt: string;
  verifiedAt: string;
  contentHash: string;
}

export interface AttemptSettlement {
  sequence: number;
  type: "initial" | "repair" | "continuation" | "retry";
  model: string;
  accountId?: string;
  egressHash?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: number;
  outcome: "success" | "failure" | "aborted";
  usage: TokenUsage;
  billingAuthoritative: boolean;
  energyConsumedNanoKwh: number;
  energyChargedNanoKwh: number;
  upstreamCostMicroUsd?: number;
  serviceTier?: string;
  accountingMethod?: "energy" | "token";
}

export interface ExecutionSettlement {
  id: string;
  endpoint: "/v1/chat/completions" | "/v1/responses";
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: number;
  outcome: "success" | "failure" | "aborted";
  attempts: AttemptSettlement[];
  usage: TokenUsage;
  price?: PriceDefinition;
  costSource: "catalog_estimate" | "upstream_billed" | "unpriced";
  inputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  totalCostMicroUsd: number;
  energyConsumedNanoKwh: number;
  energyChargedNanoKwh: number;
  priced: boolean;
  payloadHash: string;
}

export interface SchedulerAnalyticsEvent {
  type: "demand" | "admitted" | "blocked" | "rejected" | "released";
  at: number;
  model: string;
  accountId?: string;
  egressId?: string;
  waitMs?: number;
  durationMs?: number;
  constraint?: ForecastConstraint;
}

export interface ModelAnalyticsRow {
  model: string;
  clientRpm: number;
  upstreamRpm: number;
  amplification: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalCostMicroUsd: number;
  inputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  energyConsumedNanoKwh: number;
  energyChargedNanoKwh: number;
  upstreamBilledRequests: number;
  unpricedRequests: number;
  priceSource?: PriceSource;
  priceVerifiedAt?: string;
  p95DurationMs: number;
  effectiveCapacityRpm: number;
  utilization: number;
  recommendedAccounts: number;
  bindingConstraint: ForecastConstraint;
  confidence: "high" | "medium" | "low";
}

export interface AnalyticsSeriesPoint {
  minute: string;
  clientRequests: number;
  upstreamAttempts: number;
  demand: number;
  admitted: number;
  rejected: number;
  totalCostMicroUsd: number;
}

export interface CapacityRecommendation {
  model: string;
  forecastRpm: number;
  effectiveCapacityRpm: number;
  utilization: number;
  recommendedAccounts: number;
  bindingConstraint: ForecastConstraint;
  confidence: "high" | "medium" | "low";
  sampleMinutes: number;
  p95SampleCount: number;
  p95DurationMs: number;
  p95Amplification: number;
  safetyMargin: number;
  timeToThresholdMinutes?: number;
  stabilizing?: boolean;
}

export interface AnalyticsOverview {
  health: AnalyticsHealthStatus;
  error?: string;
  ledgerStartedAt?: string;
  priceStatus: "current" | "stale" | "unavailable";
  priceUpdatedAt?: string;
  clientRpm: number;
  upstreamRpm: number;
  amplification: number;
  utilization: number;
  trend15m: number;
  todayCostMicroUsd: number;
  monthCostMicroUsd: number;
  todayEnergyConsumedNanoKwh: number;
  monthEnergyConsumedNanoKwh: number;
  pricedCoverage: number;
  unpricedRequests: number;
  unpricedTokens: number;
  series: AnalyticsSeriesPoint[];
  models: ModelAnalyticsRow[];
  recommendation?: CapacityRecommendation;
  anomalies: string[];
}

export type AnalyticsGranularity = "minute" | "5m" | "hour" | "day";
export type AnalyticsSort = "cost" | "utilization" | "rpm" | "tokens";

export interface AnalyticsQueryOptions {
  model?: string;
  granularity: AnalyticsGranularity;
  sort: AnalyticsSort;
  direction: "asc" | "desc";
}

export interface AnalyticsQueryResult {
  from: string;
  to: string;
  granularity: AnalyticsGranularity;
  sort: AnalyticsSort;
  direction: "asc" | "desc";
  models: ModelAnalyticsRow[];
  series: AnalyticsSeriesPoint[];
  totalCostMicroUsd: number;
  inputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  energyConsumedNanoKwh: number;
  energyChargedNanoKwh: number;
  pricedRequests: number;
  unpricedRequests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
}

export interface AnalyticsRetention {
  executionDays: number | null;
  minuteDays: number | null;
}

export interface CleanupPreview {
  token: string;
  cutoff: string;
  executions: number;
  attempts: number;
  minuteBuckets: number;
  expiresAt: string;
}
