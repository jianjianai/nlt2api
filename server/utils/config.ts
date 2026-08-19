import { resolve } from "node:path";

export interface ProxyConfig {
  adminToken: string;
  apiKey: string;
  allowAnonymous: boolean;
  dataDir: string;
  defaultModel: string;
  maxRecordBytes: number;
  maxRequestBytes: number;
  maxOutputTokens: number;
  maxResponseHistoryBytes: number;
  maxResponseStateBytes: number;
  maxUpstreamBytes: number;
  upstreamTimeoutMs: number;
}

let cachedConfig: ProxyConfig | undefined;

export function getProxyConfig(): ProxyConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const rawMaxRecordBytes = Number(process.env.NEURALWATT_MAX_RECORD_BYTES ?? "5242880");
  const rawMaxRequestBytes = Number(process.env.NEURALWATT_MAX_REQUEST_BYTES ?? "8388608");
  const rawMaxOutputTokens = Number(process.env.NEURALWATT_MAX_OUTPUT_TOKENS ?? "128000");
  const rawMaxResponseHistoryBytes = Number(process.env.NEURALWATT_MAX_RESPONSE_HISTORY_BYTES ?? "2097152");
  const rawMaxResponseStateBytes = Number(process.env.NEURALWATT_MAX_RESPONSE_STATE_BYTES ?? "16777216");
  const rawMaxUpstreamBytes = Number(process.env.NEURALWATT_MAX_UPSTREAM_BYTES ?? "16777216");
  const rawUpstreamTimeoutMs = Number(process.env.NEURALWATT_UPSTREAM_TIMEOUT_MS ?? "120000");
  cachedConfig = {
    adminToken: process.env.NEURALWATT_ADMIN_TOKEN ?? "",
    apiKey: process.env.NEURALWATT_API_KEY ?? "",
    allowAnonymous: process.env.NEURALWATT_ALLOW_ANONYMOUS === "true",
    dataDir: resolve(process.env.NEURALWATT_DATA_DIR ?? ".data/neuralwatt"),
    defaultModel: process.env.NEURALWATT_DEFAULT_MODEL ?? "kimi-k3-fast",
    maxRecordBytes: Number.isFinite(rawMaxRecordBytes) && rawMaxRecordBytes > 0
      ? Math.floor(rawMaxRecordBytes)
      : 5_242_880,
    maxRequestBytes: Number.isFinite(rawMaxRequestBytes) && rawMaxRequestBytes > 0
      ? Math.floor(rawMaxRequestBytes)
      : 8_388_608,
    maxOutputTokens: Number.isFinite(rawMaxOutputTokens) && rawMaxOutputTokens > 0
      ? Math.max(1, Math.min(1_000_000, Math.floor(rawMaxOutputTokens)))
      : 128_000,
    maxResponseHistoryBytes: Number.isFinite(rawMaxResponseHistoryBytes) && rawMaxResponseHistoryBytes > 0
      ? Math.floor(rawMaxResponseHistoryBytes)
      : 2_097_152,
    maxResponseStateBytes: Number.isFinite(rawMaxResponseStateBytes) && rawMaxResponseStateBytes > 0
      ? Math.floor(rawMaxResponseStateBytes)
      : 16_777_216,
    maxUpstreamBytes: Number.isFinite(rawMaxUpstreamBytes) && rawMaxUpstreamBytes > 0
      ? Math.floor(rawMaxUpstreamBytes)
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
