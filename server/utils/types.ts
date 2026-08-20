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
  session?: PortalSession;
  createdAt: string;
  updatedAt: string;
}

export interface ProxySettings {
  recordMessages: boolean;
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

export type DebugUpstreamCallType = "initial" | "repair";

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
  endpoint: "/v1/chat/completions";
  accountId?: string;
  accountLabel?: string;
  clientRequest: DebugRawBody;
  clientResponse?: DebugRawBody;
  upstreamCalls?: DebugUpstreamCall[];
  toolCallAdapter?: ToolCallAdapterTrace;
  status: number;
  error?: string;
}
