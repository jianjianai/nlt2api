import { resolve } from "node:path";

export interface ProxyConfig {
  adminToken: string;
  apiKey: string;
  allowAnonymous: boolean;
  dataDir: string;
  defaultModel: string;
  maxRequestBytes: number;
  maxOutputTokens: number;
  maxUpstreamBytes: number;
  maxResponseHistoryBytes: number;
  maxResponseStateBytes: number;
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
  const rawUpstreamTimeoutMs = Number(process.env.NEURALWATT_UPSTREAM_TIMEOUT_MS ?? "120000");
  cachedConfig = {
    adminToken: process.env.NEURALWATT_ADMIN_TOKEN ?? "",
    apiKey: process.env.NEURALWATT_API_KEY ?? "",
    allowAnonymous: process.env.NEURALWATT_ALLOW_ANONYMOUS === "true",
    dataDir: resolve(process.env.NEURALWATT_DATA_DIR ?? ".data/neuralwatt"),
    defaultModel: process.env.NEURALWATT_DEFAULT_MODEL ?? "kimi-k3-fast",
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
    upstreamTimeoutMs: Number.isFinite(rawUpstreamTimeoutMs) && rawUpstreamTimeoutMs > 0
      ? Math.floor(rawUpstreamTimeoutMs)
      : 120_000,
  };

  return cachedConfig;
}

export function resetProxyConfigForTests(): void {
  cachedConfig = undefined;
}
