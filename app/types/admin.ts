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

export interface ApiPayload {
  accounts?: Account[];
  settings?: GatewaySettings;
  proxyPool?: ProxyPoolEntry[];
  proxies?: ProxyPoolEntry[];
  results?: ProxyImportLineResult[];
  proxy?: ProxyPoolEntry;
  scheduler?: SchedulerRuntime;
  config?: GatewayConfig;
  records?: DebugRecordSummary[];
  record?: DebugRecord;
  account?: Account | null;
  models?: string[];
}
