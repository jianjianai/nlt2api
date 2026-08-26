import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MinterConfig {
  /** WebSocket endpoint derived from GATEWAY_URL. */
  wsUrl: string;
  gatewayUrl: string;
  token: string;
  agentId: string;
  label: string;
  concurrency: number;
  browserPath?: string;
  profileDir: string;
  display: string;
  basePort: number;
  /** Fallback only; the gateway sends the authoritative key in `welcome`. */
  siteKey: string;
  idleReleaseMs: number;
  mintTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_SITE_KEY = "0x4AAAAAADlBNBTRb73O02Vo";

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const trimmed = raw?.trim();
  // Number("") is 0, so an unset variable must be rejected before parsing or it
  // would clamp to `min` instead of using the default.
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Turns the gateway HTTP origin into the /ws/minter WebSocket URL. */
export function websocketUrl(gatewayUrl: string): string {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new ConfigError(`GATEWAY_URL is not a valid URL: ${gatewayUrl}`);
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ConfigError(`GATEWAY_URL must use http, https, ws or wss, got ${url.protocol}`);
  }
  const base = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${base}/ws/minter`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MinterConfig {
  const gatewayUrl = env.GATEWAY_URL?.trim();
  if (!gatewayUrl) throw new ConfigError("GATEWAY_URL is required, for example http://gateway:3000");
  const token = env.MINTER_TOKEN?.trim();
  if (!token) throw new ConfigError("MINTER_TOKEN is required and must match the gateway.");

  const host = hostname();
  return {
    gatewayUrl,
    wsUrl: websocketUrl(gatewayUrl),
    token,
    agentId: env.MINTER_AGENT_ID?.trim() || `${host}-${Math.random().toString(36).slice(2, 8)}`,
    label: env.MINTER_LABEL?.trim() || host,
    concurrency: boundedInt(env.MINTER_CONCURRENCY, 1, 1, 16),
    ...(env.MINTER_BROWSER_PATH?.trim() ? { browserPath: env.MINTER_BROWSER_PATH.trim() } : {}),
    // Must stay OUTSIDE any watched workspace: Chromium rewrites lock files
    // constantly and a dev-server file watcher crashes with EBUSY on them.
    profileDir: env.MINTER_PROFILE_DIR?.trim() || join(tmpdir(), "nlt-minter-profile"),
    display: env.MINTER_DISPLAY?.trim() || ":99",
    basePort: boundedInt(env.MINTER_BASE_PORT, 9_333, 1_024, 65_000),
    siteKey: env.MINTER_SITEKEY?.trim() || DEFAULT_SITE_KEY,
    idleReleaseMs: boundedInt(env.MINTER_IDLE_RELEASE_MS, 600_000, 0, 3_600_000),
    mintTimeoutMs: boundedInt(env.MINTER_MINT_TIMEOUT_MS, 60_000, 5_000, 300_000),
  };
}
