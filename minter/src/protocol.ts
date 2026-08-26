/**
 * Wire format for the gateway ↔ minter WebSocket link. Kept in sync by hand with
 * the gateway copy; the two projects deploy independently.
 *
 * Spec: docs/designs/2026-08-26-minter-ws-protocol.md
 */

export const MAX_FRAME_BYTES = 64 * 1024;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** No frame at all within this window means the link is dead; reconnect. */
export const INBOUND_SILENCE_TIMEOUT_MS = 60_000;

export type MintFailureReason =
  | "proxy_connect_failed"
  | "proxy_auth_failed"
  | "proxy_timeout"
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

export interface WelcomeMessage {
  type: "welcome";
  sessionId: string;
  serverVersion: string;
  heartbeatIntervalMs: number;
  siteKey: string;
  ticketTtlSeconds: number;
}

export interface MintRequestMessage {
  type: "mint.request";
  id: string;
  count: number;
  deadlineMs: number;
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

export interface LeaseExtendedMessage { type: "lease.extended"; id: string; leaseId: string; expiresAt: number }
export interface LeaseLostMessage { type: "lease.lost"; id: string; leaseId: string; reason: string }
export interface TicketAcceptedMessage { type: "ticket.accepted"; id: string; ticketId: string; expiresAt: number }
export interface TicketRejectedMessage { type: "ticket.rejected"; id: string; reason: string }
export interface PingMessage { type: "ping"; id: string }
export interface PongMessage { type: "pong"; id: string }

export type GatewayMessage =
  | WelcomeMessage
  | MintRequestMessage
  | ProxyLeasedMessage
  | ProxyUnavailableMessage
  | LeaseExtendedMessage
  | LeaseLostMessage
  | TicketAcceptedMessage
  | TicketRejectedMessage
  | PingMessage
  | PongMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parses one inbound frame; unknown or malformed types yield undefined. */
export function parseGatewayMessage(raw: string): GatewayMessage | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || typeof payload.type !== "string") return undefined;

  switch (payload.type) {
    case "welcome": {
      const sessionId = str(payload.sessionId);
      const siteKey = str(payload.siteKey);
      const serverVersion = str(payload.serverVersion) ?? "unknown";
      const heartbeatIntervalMs = num(payload.heartbeatIntervalMs) ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      const ticketTtlSeconds = num(payload.ticketTtlSeconds) ?? 170;
      if (!sessionId || !siteKey) return undefined;
      return { type: "welcome", sessionId, siteKey, serverVersion, heartbeatIntervalMs, ticketTtlSeconds };
    }
    case "mint.request": {
      const id = str(payload.id);
      const count = num(payload.count);
      const deadlineMs = num(payload.deadlineMs);
      if (!id || count === undefined || deadlineMs === undefined) return undefined;
      return { type: "mint.request", id, count: Math.max(1, Math.floor(count)), deadlineMs };
    }
    case "proxy.leased": {
      const id = str(payload.id);
      const leaseId = str(payload.leaseId);
      const proxyId = str(payload.proxyId);
      const proxyUrl = str(payload.proxyUrl);
      const kind = str(payload.kind);
      const expiresAt = num(payload.expiresAt);
      if (!id || !leaseId || !proxyId || !proxyUrl || expiresAt === undefined) return undefined;
      if (kind !== "http" && kind !== "socks4" && kind !== "socks5") return undefined;
      return { type: "proxy.leased", id, leaseId, proxyId, proxyUrl, kind, expiresAt };
    }
    case "proxy.unavailable": {
      const id = str(payload.id);
      const reason = str(payload.reason);
      if (!id || !reason) return undefined;
      return {
        type: "proxy.unavailable",
        id,
        reason: reason as ProxyUnavailableMessage["reason"],
        retryAfterMs: num(payload.retryAfterMs) ?? 5_000,
      };
    }
    case "lease.extended": {
      const id = str(payload.id);
      const leaseId = str(payload.leaseId);
      const expiresAt = num(payload.expiresAt);
      if (!id || !leaseId || expiresAt === undefined) return undefined;
      return { type: "lease.extended", id, leaseId, expiresAt };
    }
    case "lease.lost": {
      const id = str(payload.id);
      const leaseId = str(payload.leaseId);
      if (!id || !leaseId) return undefined;
      return { type: "lease.lost", id, leaseId, reason: str(payload.reason) ?? "expired" };
    }
    case "ticket.accepted": {
      const id = str(payload.id);
      const ticketId = str(payload.ticketId);
      const expiresAt = num(payload.expiresAt);
      if (!id || !ticketId || expiresAt === undefined) return undefined;
      return { type: "ticket.accepted", id, ticketId, expiresAt };
    }
    case "ticket.rejected": {
      const id = str(payload.id);
      if (!id) return undefined;
      return { type: "ticket.rejected", id, reason: str(payload.reason) ?? "invalid_payload" };
    }
    case "ping":
    case "pong": {
      const id = str(payload.id);
      return id ? { type: payload.type, id } : undefined;
    }
    default:
      return undefined;
  }
}

/** Reconnect delay: exponential to a 30s ceiling with ±20% jitter. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}
