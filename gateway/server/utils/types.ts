export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProxyKind = "http" | "socks4" | "socks5";

/**
 * The three states the admin console exposes. `pending` covers both freshly
 * imported proxies and ones cooling down after a failure below the threshold.
 */
export type ProxyStatus = "active" | "pending" | "unavailable";

export interface ProxyRecord {
  id: string;
  url: string;
  kind: ProxyKind;
  status: ProxyStatus;
  label?: string;
  createdAt: number;
  updatedAt: number;
  checkedAt?: number;
  healthyAt?: number;
  latencyMs?: number;
  failureCount: number;
  lastError?: string;
  retryAfter?: number;
  leasedBy?: string;
  leaseId?: string;
  leaseExpires?: number;
}

/** Admin-facing proxy shape; the URL is masked and credentials never leave the server. */
export interface ProxyPublic {
  id: string;
  maskedUrl: string;
  kind: ProxyKind;
  status: ProxyStatus;
  label?: string;
  createdAt: number;
  updatedAt: number;
  checkedAt?: number;
  healthyAt?: number;
  latencyMs?: number;
  failureCount: number;
  lastError?: string;
  retryAfter?: number;
  leased: boolean;
  /** False when the proxy cannot drive a browser (authenticated SOCKS). */
  mintable: boolean;
  availableTickets: number;
}

export interface TicketRecord {
  id: string;
  proxyId: string;
  token: string;
  source: string;
  userAgent?: string;
  mintedAt: number;
  expiresAt: number;
  claimedAt?: number;
  minterId?: string;
}

/** A ticket together with the proxy it was minted through; the two travel as a pair. */
export interface TicketPair {
  ticket: TicketRecord;
  proxyUrl: string;
}

export interface TicketPublic {
  id: string;
  proxyId: string;
  maskedProxyUrl: string;
  maskedToken: string;
  source: string;
  mintedAt: number;
  expiresAt: number;
  remainingMs: number;
  minterId?: string;
}

export interface MinterSessionRecord {
  id: string;
  agentId: string;
  label?: string;
  version: string;
  platform: string;
  concurrency: number;
  remoteAddr?: string;
  connectedAt: number;
  lastSeenAt: number;
  disconnectedAt?: number;
  mintedCount: number;
  failedCount: number;
  lastError?: string;
}

export interface MinterSessionPublic extends MinterSessionRecord {
  online: boolean;
  inflight: number;
  leases: number;
}

export interface GatewaySettings {
  /** Pool lifetime of a ticket. Upstream accepts ~178s; 170 leaves a safety margin. */
  ticketTtlSeconds: number;
  /** A ticket must still have this much life left to be handed to a request. */
  ticketMinRemainingSeconds: number;
  ticketCleanupIntervalSeconds: number;
  /** Refill is triggered while fewer than this many tickets are available. */
  minAvailableTickets: number;
  refillIntervalSeconds: number;
  mintRequestTimeoutSeconds: number;
  proxyLeaseSeconds: number;
  proxyCheckIntervalSeconds: number;
  proxyCheckTimeoutSeconds: number;
  proxyCheckConcurrency: number;
  proxyFailureThreshold: number;
  proxyRetryCooldownSeconds: number;
  modelsCacheSeconds: number;
  maxAttempts: number;
  upstreamTimeoutMs: number;
}

export interface OverviewSnapshot {
  proxies: Record<ProxyStatus, number>;
  proxiesMintable: number;
  tickets: {
    available: number;
    total: number;
    minAvailable: number;
  };
  minters: {
    online: number;
    inflight: number;
  };
  mintRate: {
    minted: number;
    failed: number;
    windowMinutes: number;
  };
  config: {
    apiKeyConfigured: boolean;
    adminTokenConfigured: boolean;
    minterTokenConfigured: boolean;
    allowAnonymous: boolean;
  };
}
