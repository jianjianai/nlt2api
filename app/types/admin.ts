export interface SchedulerSettings {
  accountModelConcurrency: number;
  accountRpm: number;
  proxyRpm: number;
  directEgressLimitEnabled: boolean;
  directEgressRpm: number;
  stickyTtlSeconds: number;
  queueTimeoutSeconds: number;
  maxQueueSize: number;
}

export interface AccountSchedulerOverrides {
  accountRpm?: number;
  accountModelConcurrency?: number;
  modelConcurrency?: Record<string, number>;
}

export interface RuntimeState {
  inFlight: number;
  modelInFlight: Record<string, number>;
  requestsLastMinute: number;
  nextRateAvailableAt?: number;
  modelCooldownUntil: Record<string, number>;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError?: string;
  lastUsedAt?: string;
  lastSuccessAt?: string;
}

export type ProxyKind = "http" | "socks4" | "socks5";
export type ProxyPoolStatus = "idle" | "checking" | "in_use" | "error";

export interface ProxyPoolSettings {
  autoAssignOnAccountCreate: boolean;
  autoRotateOnTransportError: boolean;
  retryCurrentRequestAfterRotation: boolean;
  directFallbackWhenExhausted: boolean;
  defaultImportProtocol: ProxyKind;
  healthCheckTimeoutSeconds: number;
  errorRetryCooldownSeconds: number;
}

export interface ProxyPoolEntry {
  id: string;
  maskedUrl: string;
  kind: ProxyKind;
  status: ProxyPoolStatus;
  accountId?: string;
  accountLabel?: string;
  lastCheckedAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  failedAt?: string;
  retryAfter?: number;
}

export interface ProxyImportLineResult {
  line: number;
  source: string;
  status: "created" | "existing" | "invalid";
  error?: string;
}

export interface Account {
  id: string;
  label: string;
  email: string;
  password: string;
  enabled: boolean;
  weight: number;
  proxy: string | null;
  proxyPoolEntryId?: string;
  models: string[];
  schedulerOverrides?: AccountSchedulerOverrides;
  hasSession: boolean;
  sessionExpiresAt: number | null;
  createdAt: string;
  updatedAt: string;
  runtime: RuntimeState;
}

export type ToolCallFormat = "auto" | "json" | "xml";
export type PreambleVerbosity = "quiet" | "normal" | "verbose" | "milestone";
export type ThemeId = "light" | "gray" | "dark";
export type WorkspaceId = "overview" | "accounts" | "proxies" | "scheduler" | "records" | "settings";
export type OperationalWorkspaceId = Exclude<WorkspaceId, "settings">;

export interface GatewaySettings {
  recordMessages: boolean;
  scheduler: SchedulerSettings;
  proxyPool: ProxyPoolSettings;
  minimumOutputTokens?: number;
  toolCallFormat?: ToolCallFormat;
  preambleVerbosity?: PreambleVerbosity;
  modelToolCallFormats?: Record<string, ToolCallFormat>;
  modelPreambleVerbosities?: Record<string, PreambleVerbosity>;
}

export interface GatewayConfig {
  adminTokenConfigured: boolean;
  clientApiKeyRequired: boolean;
  clientApiKey: string;
  defaultModel: string;
  minimumOutputTokens: number;
  toolCallFormat?: ToolCallFormat;
  preambleVerbosity?: PreambleVerbosity;
}

export interface EgressRuntime {
  id: string;
  accountCount: number;
  requestsLastMinute: number;
  nextRateAvailableAt?: number;
  limited: boolean;
  rpm: number;
}

export interface SchedulerRuntime {
  pending: number;
  oldestWaitMs: number;
  egresses: EgressRuntime[];
}

export interface DebugRawBody {
  contentType: "application/json" | "text/event-stream" | "text/plain";
  body: string;
}

export interface DebugUpstreamCall {
  sequence: number;
  type: "initial" | "repair" | "continuation";
  round: number;
  attempt: number;
  accountId?: string;
  accountLabel?: string;
  request: DebugRawBody;
  response?: DebugRawBody;
  responseStatus?: number;
  error?: string;
}

export interface DebugRecord {
  id: string;
  at: string;
  endpoint: string;
  accountId?: string;
  accountLabel?: string;
  clientRequest: DebugRawBody | Record<string, unknown>;
  clientResponse?: DebugRawBody | Record<string, unknown>;
  upstreamCalls?: DebugUpstreamCall[];
  upstreamRequest?: Record<string, unknown>;
  upstreamResponse?: Record<string, unknown>;
  toolCallAdapter?: {
    toolCallExpected: "auto" | "required" | "forced";
    initialParseSucceeded: boolean;
    finalParseSucceeded: boolean;
    initialParseRepaired?: boolean;
    finalParseRepaired?: boolean;
    initialOutcome: "tool_calls" | "final" | "invalid";
    finalOutcome: "tool_calls" | "final" | "invalid";
    repairAttempts: number;
    maxRepairAttempts: number;
    errors: string[];
  };
  status: number;
  error?: string;
}

export interface DebugUpstreamCallSummary {
  sequence: number;
  type: "initial" | "repair" | "continuation";
  round: number;
  attempt: number;
  accountId?: string;
  accountLabel?: string;
  responseStatus?: number;
  error?: string;
}

export interface DebugRecordSummary {
  id: string;
  at: string;
  endpoint: string;
  model?: string;
  status: number;
  accountId?: string;
  accountLabel?: string;
  error?: string;
  preview: string;
  upstreamCalls?: DebugUpstreamCallSummary[];
  legacyUpstream?: boolean;
  toolCall?: {
    forces: boolean;
    initialOutcome: "tool_calls" | "final" | "invalid";
    finalOutcome: "tool_calls" | "final" | "invalid";
  };
}

export interface DisplayToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface DisplayMessage {
  role: string;
  roleLabel: string;
  content: string;
  toolCalls: DisplayToolCall[];
}

export interface DisplayField {
  label: string;
  value: string;
}

export interface BodyPresentation {
  contentType: string;
  raw: string;
  fields: DisplayField[];
  messages: DisplayMessage[];
}

export interface ConversationTrace {
  key: string;
  record: DebugRecord;
  direction: "client" | "upstream";
  title: string;
  subtitle: string;
  request: DebugRawBody | Record<string, unknown>;
  response?: DebugRawBody | Record<string, unknown>;
  status: number;
  error?: string;
}

export interface SidebarUpstreamItem {
  key: string;
  title: string;
  subtitle: string;
  status: number;
  failed: boolean;
}

export interface SidebarItem {
  record: DebugRecordSummary;
  upstream: SidebarUpstreamItem[];
}

export type ForecastConstraint =
  | "account_rpm"
  | "model_concurrency"
  | "shared_egress_rpm"
  | "no_healthy_account"
  | "model_cooldown"
  | "account_cooldown"
  | "queue_policy"
  | "insufficient_samples";

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
  unpricedRequests: number;
  priceSource?: "vendor_official" | "portal_catalog";
  priceVerifiedAt?: string;
  p95DurationMs: number;
  effectiveCapacityRpm: number;
  utilization: number;
  recommendedAccounts: number;
  bindingConstraint: ForecastConstraint;
  confidence: "high" | "medium" | "low";
}

export interface AnalyticsOverview {
  health: "healthy" | "degraded";
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

export interface ApiPayload {
  accounts?: Account[];
  settings?: GatewaySettings;
  proxyPool?: ProxyPoolEntry[];
  proxies?: ProxyPoolEntry[];
  results?: ProxyImportLineResult[];
  proxy?: ProxyPoolEntry;
  scheduler?: SchedulerRuntime;
  analytics?: AnalyticsOverview;
  result?: AnalyticsQueryResult;
  retention?: AnalyticsRetention;
  preview?: CleanupPreview;
  refreshed?: boolean;
  deleted?: { executions: number; attempts: number; minuteBuckets: number };
  config?: GatewayConfig;
  records?: DebugRecordSummary[];
  record?: DebugRecord;
  account?: Account | null;
  models?: string[];
}
