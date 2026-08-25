export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
    strict?: boolean;
  };
}

export interface NormalizedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: JsonValue;
  name?: string;
  tool_call_id?: string;
  tool_calls?: NormalizedToolCall[];
  reasoning?: string;
  reasoning_content?: string;
  refusal?: string | null;
  [key: string]: JsonValue | NormalizedToolCall[] | undefined;
}

export interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: JsonValue | undefined;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: JsonValue | undefined;
  };
  [key: string]: JsonValue | undefined;
}

export interface UpstreamChoice {
  index?: number;
  message?: ChatMessage;
  delta?: ChatMessage;
  finish_reason?: string | null;
  [key: string]: JsonValue | ChatMessage | undefined;
}

export interface UpstreamEnergy {
  energy_joules?: number;
  energy_kwh?: number;
  energy_kwh_charged?: number;
  pricing_multiplier?: number;
  attribution_method?: string;
  [key: string]: JsonValue | undefined;
}

export interface UpstreamCost {
  request_cost_usd?: number;
  cache_savings_usd?: number;
  allowance_remaining_usd?: number;
  accounting_method?: "energy" | "token";
  [key: string]: JsonValue | undefined;
}

export interface UpstreamCompletion {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: UpstreamChoice[];
  usage?: UpstreamUsage;
  energy?: UpstreamEnergy;
  cost?: UpstreamCost;
  service_tier?: string;
  system_fingerprint?: string;
  [key: string]: JsonValue | UpstreamChoice[] | UpstreamUsage | UpstreamEnergy | UpstreamCost | undefined;
}

export interface PortalSession {
  cookie: string;
  expiresAt: number | null;
  updatedAt: string;
}

export interface SchedulerSettings {
  accountModelConcurrency: number;
  accountRpm: number;
  proxyRpm: number;
  directEgressLimitEnabled: boolean;
  directEgressRpm: number;
  stickyTtlSeconds: number;
  /** Zero waits without a scheduler-imposed timeout. */
  queueTimeoutSeconds: number;
  /** Zero leaves the pending queue unbounded. */
  maxQueueSize: number;
}

export const DEFAULT_SCHEDULER_SETTINGS: Readonly<SchedulerSettings> = Object.freeze({
  accountModelConcurrency: 5,
  accountRpm: 20,
  proxyRpm: 30,
  directEgressLimitEnabled: false,
  directEgressRpm: 30,
  stickyTtlSeconds: 30 * 60,
  queueTimeoutSeconds: 0,
  maxQueueSize: 0,
});

export interface AccountSchedulerOverrides {
  accountRpm?: number;
  accountModelConcurrency?: number;
  modelConcurrency?: Record<string, number>;
}

export type ProxyKind = "http" | "socks4" | "socks5";

export interface ProxyPoolSettings {
  autoAssignOnAccountCreate: boolean;
  autoRotateOnTransportError: boolean;
  retryCurrentRequestAfterRotation: boolean;
  directFallbackWhenExhausted: boolean;
  defaultImportProtocol: ProxyKind;
  healthCheckTimeoutSeconds: number;
  errorRetryCooldownSeconds: number;
}

export const DEFAULT_PROXY_POOL_SETTINGS: Readonly<ProxyPoolSettings> = Object.freeze({
  autoAssignOnAccountCreate: false,
  autoRotateOnTransportError: false,
  retryCurrentRequestAfterRotation: true,
  directFallbackWhenExhausted: false,
  defaultImportProtocol: "http",
  healthCheckTimeoutSeconds: 10,
  errorRetryCooldownSeconds: 300,
});

export interface ProxyPoolEntry {
  id: string;
  url: string;
  kind: ProxyKind;
  label?: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  failedAt?: string;
  retryAfter?: number;
}

export interface AccountGroup {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupApiKey {
  id: string;
  groupId: string;
  name: string;
  prefix: string;
  secretDigest: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ClientPrincipal =
  | { scope: "global" }
  | { scope: "group"; groupId: string; apiKeyId: string };

export type ResponseAccessScope =
  | { scope: "global" }
  | { scope: "group"; groupId: string };

export interface ManagedAccount {
  id: string;
  label: string;
  enabled: boolean;
  weight: number;
  /** Optional per-account egress proxy URL (http/https/socks4/socks5). */
  proxy?: string;
  /** Pool owner for `proxy`; absent for direct or custom manually-entered proxies. */
  proxyPoolEntryId?: string;
  /** Groups allowed to schedule this account. Capacity remains account-global. */
  groupIds: string[];
  /** Anonymous DeepInfra model ids available through this egress. */
  models: string[];
  schedulerOverrides?: AccountSchedulerOverrides;
  createdAt: string;
  updatedAt: string;
}

export interface ProxySettings {
  recordMessages: boolean;
  scheduler: SchedulerSettings;
  proxyPool: ProxyPoolSettings;
  /** Minimum per-round portal output budget; zero respects the client value. */
  minimumOutputTokens?: number;
  /**
   * Global default tool-call wire format offered to upstream models.
   * Per-model overrides win; falls back to DEEPINFRA_GATEWAY_TOOL_CALL_FORMAT.
   */
  toolCallFormat?: "auto" | "json" | "xml";
  /** Per-model tool-call wire-format overrides, keyed by model id. */
  modelToolCallFormats?: Record<string, "auto" | "json" | "xml">;
  /** Per-model preamble-verbosity overrides, keyed by model id. */
  modelPreambleVerbosities?: Record<string, "quiet" | "normal" | "verbose" | "milestone">;
  /**
   * How readily the contract asks the model for user-visible preambles.
   * Falls back to DEEPINFRA_GATEWAY_PREAMBLE_VERBOSITY.
   */
  preambleVerbosity?: "quiet" | "normal" | "verbose" | "milestone";
}

export interface PersistentState {
  version: 3;
  settings: ProxySettings;
  accounts: ManagedAccount[];
  proxyPool: ProxyPoolEntry[];
  accountGroups: AccountGroup[];
  groupApiKeys: GroupApiKey[];
}

export interface AccountRuntimeState {
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

export interface PublicAccount {
  id: string;
  label: string;
  enabled: boolean;
  weight: number;
  proxy: string | null;
  proxyPoolEntryId?: string;
  groupIds: string[];
  models: string[];
  schedulerOverrides?: AccountSchedulerOverrides;
  createdAt: string;
  updatedAt: string;
  runtime: AccountRuntimeState;
}

export interface EgressRuntimeState {
  id: string;
  accountCount: number;
  requestsLastMinute: number;
  nextRateAvailableAt?: number;
  limited: boolean;
  rpm: number;
}

export interface SchedulerRuntimeSnapshot {
  pending: number;
  oldestWaitMs: number;
  egresses: EgressRuntimeState[];
}

export interface ToolCallAdapterTrace {
  toolCallExpected: "auto" | "required" | "forced";
  initialParseSucceeded: boolean;
  finalParseSucceeded: boolean;
  /** True when the accepted envelope parse needed jsonrepair to modify the raw text. */
  initialParseRepaired?: boolean;
  finalParseRepaired?: boolean;
  initialOutcome: "tool_calls" | "final" | "invalid";
  finalOutcome: "tool_calls" | "final" | "invalid";
  repairAttempts: number;
  maxRepairAttempts: number;
  errors: string[];
}

export interface DebugRawBody {
  contentType: "application/json" | "text/event-stream" | "text/plain";
  body: string;
}

/** Persisted Responses API state for `previous_response_id` chaining. */
export interface StoredResponseState {
  id: string;
  createdAt: string;
  access: ResponseAccessScope;
  model: string;
  previousResponseId?: string;
  /** Normalized Responses input items: request input plus the output items. */
  items: JsonObject[];
}

export type DebugUpstreamCallType = "initial" | "repair" | "continuation";

export interface DebugUpstreamCall {
  sequence: number;
  type: DebugUpstreamCallType;
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
  endpoint: "/v1/chat/completions" | "/v1/responses";
  accountId?: string;
  accountLabel?: string;
  clientRequest: DebugRawBody;
  clientResponse?: DebugRawBody;
  upstreamCalls?: DebugUpstreamCall[];
  toolCallAdapter?: ToolCallAdapterTrace;
  status: number;
  error?: string;
}

/** Upstream call metadata kept in list summaries (no request/response bodies). */
export interface DebugUpstreamCallSummary {
  sequence: number;
  type: DebugUpstreamCallType;
  round: number;
  attempt: number;
  accountId?: string;
  accountLabel?: string;
  responseStatus?: number;
  error?: string;
}

/**
 * Lightweight record metadata for list views. Bodies stay on disk and are
 * only read when a single record is requested via `getDebugRecord`.
 */
export interface DebugRecordSummary {
  id: string;
  at: string;
  endpoint: DebugRecord["endpoint"];
  /** Model id from the client request body, when present. */
  model?: string;
  status: number;
  accountId?: string;
  accountLabel?: string;
  error?: string;
  /** Short content preview: the last user message, else any last message. */
  preview: string;
  upstreamCalls?: DebugUpstreamCallSummary[];
  /** True when the record only has legacy upstreamRequest/upstreamResponse fields. */
  legacyUpstream?: boolean;
  /** Tool-call adapter outcomes plus whether the request forced tool use. */
  toolCall?: {
    forces: boolean;
    initialOutcome: ToolCallAdapterTrace["initialOutcome"];
    finalOutcome: ToolCallAdapterTrace["finalOutcome"];
  };
}
