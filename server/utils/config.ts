import { resolve } from "node:path";

/**
 * Which tool-call envelope format the injected contract offers the upstream
 * model. "auto" presents both JSON and XML and lets the model pick the one
 * it produces most reliably; the parser always accepts both either way.
 */
export type ToolCallFormat = "auto" | "json" | "xml";

/**
 * How readily the injected contract asks the upstream model for user-visible
 * preamble narration. Mirrors the type in tool-calls.ts (kept duplicate, like
 * ToolCallFormat, to avoid a config → contract import edge).
 */
export type PreambleVerbosity = "quiet" | "normal" | "verbose";

export interface ProxyConfig {
  adminToken: string;
  apiKey: string;
  allowAnonymous: boolean;
  dataDir: string;
  defaultModel: string;
  toolCallFormat: ToolCallFormat;
  preambleVerbosity: PreambleVerbosity;
  maxRequestBytes: number;
  maxOutputTokens: number;
  maxUpstreamBytes: number;
  maxResponseHistoryBytes: number;
  maxResponseStateBytes: number;
  maxResponseItems: number;
  maxChatMessages: number;
  upstreamTimeoutMs: number;
}

let cachedConfig: ProxyConfig | undefined;

export function getProxyConfig(): ProxyConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const rawMaxRequestBytes = Number(process.env.NEURALWATT_MAX_REQUEST_BYTES ?? "67108864");
  const rawMaxOutputTokens = Number(process.env.NEURALWATT_MAX_OUTPUT_TOKENS ?? "128000");
  const rawMaxUpstreamBytes = Number(process.env.NEURALWATT_MAX_UPSTREAM_BYTES ?? "16777216");
  const rawMaxResponseHistoryBytes = Number(process.env.NEURALWATT_MAX_RESPONSE_HISTORY_BYTES ?? "16777216");
  const rawMaxResponseStateBytes = Number(process.env.NEURALWATT_MAX_RESPONSE_STATE_BYTES ?? "16777216");
  const rawMaxResponseItems = Number(process.env.NEURALWATT_MAX_RESPONSE_ITEMS ?? "10000");
  const rawMaxChatMessages = Number(process.env.NEURALWATT_MAX_CHAT_MESSAGES ?? "10000");
  const rawUpstreamTimeoutMs = Number(process.env.NEURALWATT_UPSTREAM_TIMEOUT_MS ?? "120000");
  const rawToolCallFormat = process.env.NEURALWATT_TOOL_CALL_FORMAT ?? "auto";
  const rawPreambleVerbosity = process.env.NEURALWATT_PREAMBLE_VERBOSITY ?? "normal";
  cachedConfig = {
    adminToken: process.env.NEURALWATT_ADMIN_TOKEN ?? "",
    apiKey: process.env.NEURALWATT_API_KEY ?? "",
    allowAnonymous: process.env.NEURALWATT_ALLOW_ANONYMOUS === "true",
    dataDir: resolve(process.env.NEURALWATT_DATA_DIR ?? ".data/neuralwatt"),
    defaultModel: process.env.NEURALWATT_DEFAULT_MODEL ?? "kimi-k3-fast",
    toolCallFormat: rawToolCallFormat === "json" || rawToolCallFormat === "xml" ? rawToolCallFormat : "auto",
    preambleVerbosity: rawPreambleVerbosity === "quiet" || rawPreambleVerbosity === "verbose" ? rawPreambleVerbosity : "normal",
    maxRequestBytes: Number.isFinite(rawMaxRequestBytes) && rawMaxRequestBytes > 0
      ? Math.floor(rawMaxRequestBytes)
      : 67_108_864,
    maxOutputTokens: Number.isFinite(rawMaxOutputTokens) && rawMaxOutputTokens > 0
      ? Math.max(1, Math.min(1_000_000, Math.floor(rawMaxOutputTokens)))
      : 128_000,
    maxUpstreamBytes: Number.isFinite(rawMaxUpstreamBytes) && rawMaxUpstreamBytes > 0
      ? Math.floor(rawMaxUpstreamBytes)
      : 16_777_216,
    maxResponseHistoryBytes: Number.isFinite(rawMaxResponseHistoryBytes) && rawMaxResponseHistoryBytes > 0
      ? Math.floor(rawMaxResponseHistoryBytes)
      : 16_777_216,
    maxResponseStateBytes: Number.isFinite(rawMaxResponseStateBytes) && rawMaxResponseStateBytes > 0
      ? Math.floor(rawMaxResponseStateBytes)
      : 16_777_216,
    maxResponseItems: Number.isFinite(rawMaxResponseItems) && rawMaxResponseItems > 0
      ? Math.floor(rawMaxResponseItems)
      : 10_000,
    maxChatMessages: Number.isFinite(rawMaxChatMessages) && rawMaxChatMessages > 0
      ? Math.floor(rawMaxChatMessages)
      : 10_000,
    upstreamTimeoutMs: Number.isFinite(rawUpstreamTimeoutMs) && rawUpstreamTimeoutMs > 0
      ? Math.floor(rawUpstreamTimeoutMs)
      : 120_000,
  };

  return cachedConfig;
}

export function resetProxyConfigForTests(): void {
  cachedConfig = undefined;
}
