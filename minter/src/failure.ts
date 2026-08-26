import { MintError } from "./cdp.ts";
import type { MintFailureReason } from "./protocol.ts";

const PROXY_BLAMED: ReadonlySet<MintFailureReason> = new Set([
  "proxy_connect_failed",
  "proxy_auth_failed",
  "proxy_timeout",
]);

export function blamesProxy(reason: MintFailureReason): boolean {
  return PROXY_BLAMED.has(reason);
}

/**
 * Turns an arbitrary thrown value into a wire reason. Cloudflare error codes
 * surface as `turnstile:<code>` from the trap page's error-callback; a browser
 * network-layer failure to reach the proxy surfaces as an ERR_PROXY_* string.
 */
export function classifyMintFailure(error: unknown): { reason: MintFailureReason; message: string } {
  if (error instanceof MintError) return { reason: error.reason, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED/i.test(message)) {
    return { reason: "proxy_connect_failed", message };
  }
  if (/ERR_PROXY_AUTH_(UNSUPPORTED|REQUESTED)|407/i.test(message)) {
    return { reason: "proxy_auth_failed", message };
  }
  if (/ERR_TIMED_OUT|ETIMEDOUT|timed out/i.test(message)) {
    return { reason: "proxy_timeout", message };
  }
  if (/turnstile:/i.test(message)) {
    return { reason: "challenge_error", message };
  }
  return { reason: "challenge_error", message };
}
