import { resolve } from "node:path";

export interface GatewayConfig {
  /** Admin console credential. Empty disables the admin API entirely (503). */
  adminToken: string;
  /** Client credential for /v1/*. Empty rejects every client request. */
  apiKey: string;
  /** Shared secret the minter service presents on /ws/minter. */
  minterToken: string;
  /** Explicit opt-in for an unauthenticated public forwarding endpoint. */
  allowAnonymous: boolean;
  dataDir: string;
  /**
   * Turnstile site key handed to every minter over the WS welcome frame, so a
   * key rotation upstream is a single gateway-side change.
   */
  turnstileSiteKey: string;
  maxRequestBytes: number;
  maxUpstreamBytes: number;
  maxImportBytes: number;
}

const DEFAULT_SITE_KEY = "0x4AAAAAADlBNBTRb73O02Vo";

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? "");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

let cached: GatewayConfig | undefined;

export function getGatewayConfig(): GatewayConfig {
  if (cached) return cached;
  cached = {
    adminToken: process.env.GATEWAY_ADMIN_TOKEN ?? "",
    apiKey: process.env.GATEWAY_API_KEY ?? "",
    minterToken: process.env.MINTER_TOKEN ?? "",
    allowAnonymous: process.env.GATEWAY_ALLOW_ANONYMOUS === "true",
    dataDir: resolve(process.env.GATEWAY_DATA_DIR ?? ".data/gateway"),
    turnstileSiteKey: process.env.GATEWAY_TURNSTILE_SITEKEY?.trim() || DEFAULT_SITE_KEY,
    maxRequestBytes: positiveInt(process.env.GATEWAY_MAX_REQUEST_BYTES, 67_108_864),
    maxUpstreamBytes: positiveInt(process.env.GATEWAY_MAX_UPSTREAM_BYTES, 16_777_216),
    maxImportBytes: positiveInt(process.env.GATEWAY_MAX_IMPORT_BYTES, 16_777_216),
  };
  return cached;
}

export function resetGatewayConfigForTests(): void {
  cached = undefined;
}
