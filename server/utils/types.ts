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
  [key: string]: JsonValue | undefined;
}

export interface UpstreamChoice {
  index?: number;
  message?: ChatMessage;
  delta?: ChatMessage;
  finish_reason?: string | null;
  [key: string]: JsonValue | ChatMessage | undefined;
}

export interface UpstreamCompletion {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: UpstreamChoice[];
  usage?: UpstreamUsage;
  [key: string]: JsonValue | UpstreamChoice[] | UpstreamUsage | undefined;
}

export interface PortalSession {
  cookie: string;
  expiresAt: number | null;
  updatedAt: string;
}

export interface ManagedAccount {
  id: string;
  label: string;
  email: string;
  password: string;
  enabled: boolean;
  weight: number;
  /** Optional per-account egress proxy URL (http/https/socks4/socks5). */
  proxy?: string;
  /** Model ids this account can serve, fetched from the portal playground. */
  models: string[];
  session?: PortalSession;
  createdAt: string;
  updatedAt: string;
}

export interface ProxySettings {
  recordMessages: boolean;
  /**
   * Global default tool-call wire format offered to upstream models.
   * Per-model overrides win; falls back to NEURALWATT_TOOL_CALL_FORMAT.
   */
  toolCallFormat?: "auto" | "json" | "xml";
  /** Per-model tool-call wire-format overrides, keyed by model id. */
  modelToolCallFormats?: Record<string, "auto" | "json" | "xml">;
  /** Per-model preamble-verbosity overrides, keyed by model id. */
  modelPreambleVerbosities?: Record<string, "quiet" | "normal" | "verbose">;
  /**
   * How readily the contract asks the model for user-visible preambles.
   * Falls back to NEURALWATT_PREAMBLE_VERBOSITY.
   */
  preambleVerbosity?: "quiet" | "normal" | "verbose";
}

export interface PersistentState {
  version: 1;
  settings: ProxySettings;
  accounts: ManagedAccount[];
}

export interface AccountRuntimeState {
  inFlight: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError?: string;
  lastUsedAt?: string;
  lastSuccessAt?: string;
}

export interface PublicAccount {
  id: string;
  label: string;
  emailHint: string;
  enabled: boolean;
  weight: number;
  proxyHint: string | null;
  models: string[];
  hasSession: boolean;
  sessionExpiresAt: number | null;
  createdAt: string;
  updatedAt: string;
  runtime: AccountRuntimeState;
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
