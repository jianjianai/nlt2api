/**
 * Wire format for the gateway ↔ minter WebSocket link.
 * Spec: docs/designs/2026-08-26-minter-ws-protocol.md
 */
import { randomUUID } from "node:crypto";

export const MAX_FRAME_BYTES = 64 * 1024;
export const HELLO_TIMEOUT_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;
export const MAX_TOKEN_LENGTH = 4_096;
export const MAX_PROTOCOL_VIOLATIONS = 10;

export const CLOSE_FRAME_TOO_LARGE = 1009;
export const CLOSE_HELLO_TIMEOUT = 4001;
export const CLOSE_HEARTBEAT_TIMEOUT = 4002;
export const CLOSE_REPLACED = 4003;
export const CLOSE_PROTOCOL_VIOLATION = 4004;

export type MintFailureReason =
  // Blamed on the proxy: the gateway records a failure against it.
  | "proxy_connect_failed"
  | "proxy_auth_failed"
  | "proxy_timeout"
  // Blamed on the minter host: only the lease is released.
  | "browser_missing"
  | "browser_timeout"
  | "cdp_unreachable"
  | "cdp_socket"
  | "cdp_error"
  | "cdp_timeout"
  | "page_not_ready"
  | "no_token"
  | "challenge_error"
  | "aborted";

const PROXY_BLAMED: ReadonlySet<string> = new Set<MintFailureReason>([
  "proxy_connect_failed",
  "proxy_auth_failed",
  "proxy_timeout",
]);

const ALL_REASONS: ReadonlySet<string> = new Set<MintFailureReason>([
  "proxy_connect_failed",
  "proxy_auth_failed",
  "proxy_timeout",
  "browser_missing",
  "browser_timeout",
  "cdp_unreachable",
  "cdp_socket",
  "cdp_error",
  "cdp_timeout",
  "page_not_ready",
  "no_token",
  "challenge_error",
  "aborted",
]);

export function isMintFailureReason(value: unknown): value is MintFailureReason {
  return typeof value === "string" && ALL_REASONS.has(value);
}

export function blamesProxy(reason: MintFailureReason): boolean {
  return PROXY_BLAMED.has(reason);
}

export interface HelloMessage {
  type: "hello";
  agentId: string;
  label?: string;
  version: string;
  platform: string;
  concurrency: number;
}

export interface WelcomeMessage {
  type: "welcome";
  sessionId: string;
  serverVersion: string;
  heartbeatIntervalMs: number;
  siteKey: string;
  ticketTtlSeconds: number;
  /**
   * Sticky-minting band handed down from settings: a minter rotates its proxy
   * after this many consecutive tickets on it. Both 0 (or absent) disables
   * stickiness; min equals max pins every rotation to that count.
   */
  stickyMintsMin?: number;
  stickyMintsMax?: number;
}

export interface PingMessage { type: "ping"; id: string }
export interface PongMessage { type: "pong"; id: string }

export interface MintRequestMessage {
  type: "mint.request";
  id: string;
  count: number;
  deadlineMs: number;
}

export interface ProxyLeaseMessage {
  type: "proxy.lease";
  id: string;
  preferProxyId?: string;
}

export interface ProxyLeasedMessage {
  type: "proxy.leased";
  id: string;
  leaseId: string;
  proxyId: string;
  proxyUrl: string;
  kind: "http" | "socks4" | "socks5";
  expiresAt: number;
}

export interface ProxyUnavailableMessage {
  type: "proxy.unavailable";
  id: string;
  reason: "no_active_proxy" | "all_leased" | "rate_limited";
  retryAfterMs: number;
}

export interface LeaseExtendMessage { type: "lease.extend"; id: string; leaseId: string }
export interface LeaseExtendedMessage { type: "lease.extended"; id: string; leaseId: string; expiresAt: number }
export interface LeaseLostMessage {
  type: "lease.lost";
  id: string;
  leaseId: string;
  reason: "expired" | "revoked" | "proxy_deleted";
}
export interface LeaseReleaseMessage { type: "lease.release"; leaseId: string }

export interface ScreenshotRequestMessage {
  type: "browser.screenshot.request";
  id: string;
  /** `page` captures the visible viewport; `fullpage` the whole document. */
  kind: "page" | "fullpage";
}

export interface ScreenshotInstanceImage {
  /** Masked proxy URL of the browser instance this shot came from. */
  proxyUrl?: string;
  pngBase64: string;
}

export interface ScreenshotReplyMessage {
  type: "browser.screenshot.reply";
  id: string;
  ok: boolean;
  /** Base64-encoded PNG; present when ok is true (first instance). */
  pngBase64?: string;
  /** One image per resident browser when the minter runs several. */
  instances?: ScreenshotInstanceImage[];
  /** Failure detail; present when ok is false. */
  error?: string;
}

export interface TicketSubmitMessage {
  type: "ticket.submit";
  id: string;
  leaseId: string;
  token: string;
  source: string;
  userAgent?: string;
  mintedAt: number;
}

export interface TicketAcceptedMessage {
  type: "ticket.accepted";
  id: string;
  ticketId: string;
  expiresAt: number;
}

export interface TicketRejectedMessage {
  type: "ticket.rejected";
  id: string;
  reason: "lease_invalid" | "proxy_inactive" | "already_expired" | "invalid_payload";
}

export interface MintFailedMessage {
  type: "mint.failed";
  id: string;
  leaseId?: string;
  reason: MintFailureReason;
  message?: string;
}

export type MinterToGateway =
  | HelloMessage
  | PingMessage
  | PongMessage
  | ProxyLeaseMessage
  | LeaseExtendMessage
  | LeaseReleaseMessage
  | TicketSubmitMessage
  | MintFailedMessage
  | ScreenshotReplyMessage;

export type GatewayToMinter =
  | WelcomeMessage
  | PingMessage
  | PongMessage
  | MintRequestMessage
  | ProxyLeasedMessage
  | ProxyUnavailableMessage
  | LeaseExtendedMessage
  | LeaseLostMessage
  | TicketAcceptedMessage
  | TicketRejectedMessage
  | ScreenshotRequestMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * Parses one inbound frame. Returns undefined for anything malformed so the
 * caller can count a protocol violation without ever touching partial data.
 */
export function parseMinterMessage(raw: string): MinterToGateway | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || typeof payload.type !== "string") return undefined;

  switch (payload.type) {
    case "hello": {
      const agentId = boundedString(payload.agentId, 64);
      const version = boundedString(payload.version, 32);
      const platform = boundedString(payload.platform, 64);
      const concurrency = boundedInteger(payload.concurrency, 1, 16);
      if (!agentId || !version || !platform || concurrency === undefined) return undefined;
      const label = boundedString(payload.label, 64);
      return { type: "hello", agentId, version, platform, concurrency, ...(label ? { label } : {}) };
    }
    case "ping":
    case "pong": {
      const id = boundedString(payload.id, 64);
      return id ? { type: payload.type, id } : undefined;
    }
    case "proxy.lease": {
      const id = boundedString(payload.id, 64);
      if (!id) return undefined;
      const preferProxyId = boundedString(payload.preferProxyId, 64);
      return { type: "proxy.lease", id, ...(preferProxyId ? { preferProxyId } : {}) };
    }
    case "lease.extend": {
      const id = boundedString(payload.id, 64);
      const leaseId = boundedString(payload.leaseId, 64);
      return id && leaseId ? { type: "lease.extend", id, leaseId } : undefined;
    }
    case "lease.release": {
      const leaseId = boundedString(payload.leaseId, 64);
      return leaseId ? { type: "lease.release", leaseId } : undefined;
    }
    case "ticket.submit": {
      const id = boundedString(payload.id, 64);
      const leaseId = boundedString(payload.leaseId, 64);
      const token = boundedString(payload.token, MAX_TOKEN_LENGTH);
      const source = boundedString(payload.source, 64);
      const mintedAt = boundedInteger(payload.mintedAt, 0, Number.MAX_SAFE_INTEGER);
      if (!id || !leaseId || !token || !source || mintedAt === undefined) return undefined;
      const userAgent = boundedString(payload.userAgent, 512);
      return { type: "ticket.submit", id, leaseId, token, source, mintedAt, ...(userAgent ? { userAgent } : {}) };
    }
    case "mint.failed": {
      const id = boundedString(payload.id, 64);
      if (!id || !isMintFailureReason(payload.reason)) return undefined;
      const leaseId = boundedString(payload.leaseId, 64);
      const message = boundedString(payload.message, 512);
      return {
        type: "mint.failed",
        id,
        reason: payload.reason,
        ...(leaseId ? { leaseId } : {}),
        ...(message ? { message } : {}),
      };
    }
    case "browser.screenshot.reply": {
      const id = boundedString(payload.id, 64);
      if (!id || typeof payload.ok !== "boolean") return undefined;
      if (payload.ok) {
        const pngBase64 = boundedString(payload.pngBase64, MAX_TOKEN_LENGTH * 8);
        if (!pngBase64) return undefined;
        let instances: ScreenshotInstanceImage[] | undefined;
        if (Array.isArray(payload.instances)) {
          const parsed: ScreenshotInstanceImage[] = [];
          for (const entry of payload.instances) {
            if (!isRecord(entry)) continue;
            const instancePng = boundedString(entry.pngBase64, MAX_TOKEN_LENGTH * 8);
            if (!instancePng) continue;
            const instanceProxy = boundedString(entry.proxyUrl, 512);
            parsed.push({ ...(instanceProxy ? { proxyUrl: instanceProxy } : {}), pngBase64: instancePng });
          }
          if (parsed.length > 0) instances = parsed;
        }
        return {
          type: "browser.screenshot.reply",
          id,
          ok: true,
          pngBase64,
          ...(instances ? { instances } : {}),
        };
      }
      const error = boundedString(payload.error, 512);
      return error ? { type: "browser.screenshot.reply", id, ok: false, error } : undefined;
    }
    default:
      // Unknown types are ignored for forward compatibility, not treated as errors.
      return undefined;
  }
}

export function isKnownMinterMessageType(raw: string): boolean {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (!isRecord(payload) || typeof payload.type !== "string") return false;
    return [
      "hello", "ping", "pong", "proxy.lease", "lease.extend", "lease.release", "ticket.submit", "mint.failed",
      "browser.screenshot.reply",
    ].includes(payload.type);
  } catch {
    return false;
  }
}

/** Builds the framed screenshot request the gateway sends to a minter. */
export function screenshotRequestMessage(kind: "page" | "fullpage", id = randomUUID()): string {
  return JSON.stringify({ type: "browser.screenshot.request", id, kind });
}
