export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProxyKind = "http" | "socks4" | "socks5";

/**
 * The four states the admin console exposes. `pending` covers both freshly
 * imported proxies and ones cooling down after a failure below the threshold;
 * `rejected` means the proxy passed its probe but failed the quality gate
 * (`proxyMaxLatencyMs` / `proxyMinThroughputBps`) and needs operator attention.
 */
export type ProxyStatus = "active" | "pending" | "unavailable" | "rejected";

/** Why an active egress is parked: upstream 429 versus an outright 403/401. */
export type ProxyCooldownReason = "rate_limit" | "ip_blocked";

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
  /** Measured download speed through the proxy, in bits per second. */
  throughputBps?: number;
  failureCount: number;
  lastError?: string;
  /** Why a pending proxy failed the quality gate and became `rejected`. */
  rejectReason?: string;
  retryAfter?: number;
  /** Upstream 429 cooldown; the proxy is healthy but must not carry traffic yet. */
  rateLimitedUntil?: number;
  cooldownReason?: ProxyCooldownReason;
  /** Last time a request was forwarded through it; drives round-robin rotation. */
  lastUsedAt?: number;
  /** Last time it was leased for minting; keeps mints spread across egresses. */
  lastMintedAt?: number;
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
  throughputBps?: number;
  failureCount: number;
  lastError?: string;
  rejectReason?: string;
  retryAfter?: number;
  rateLimitedUntil?: number;
  cooldownReason?: ProxyCooldownReason;
  lastUsedAt?: number;
  lastMintedAt?: number;
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
  /** Floor of the adaptive water mark; the pool never aims lower while active. */
  minAvailableTickets: number;
  /** Ceiling of the adaptive water mark, so a demand spike cannot mint forever. */
  maxAvailableTickets: number;
  /** Seconds of measured demand the pool keeps pre-minted ahead of requests. */
  targetLeadSeconds: number;
  /** Trailing window the claim rate is measured over. */
  demandWindowSeconds: number;
  /** Minting pauses after this long without a request; 0 keeps it always on. */
  idleAfterSeconds: number;
  /** Requests allowed to wait for a pair; 0 rejects instead of queueing. */
  queueMaxSize: number;
  /** How long a queued request waits before giving up. */
  queueTimeoutSeconds: number;
  /** How long one conversation stays pinned to its egress IP; 0 disables affinity. */
  affinityTtlSeconds: number;
  /** How long a pinned request waits for its own egress before accepting another. */
  affinityWaitSeconds: number;
  /** Fallback cooldown for an egress that returned 429 without a Retry-After. */
  rateLimitCooldownSeconds: number;
  /** Cooldown for an egress the upstream refused outright (403/401). */
  ipBlockCooldownSeconds: number;
  refillIntervalSeconds: number;
  mintRequestTimeoutSeconds: number;
  proxyLeaseSeconds: number;
  proxyCheckIntervalSeconds: number;
  proxyCheckTimeoutSeconds: number;
  proxyCheckConcurrency: number;
  /** Probe pass/fail gate: latency above this (ms) rejects the proxy. */
  proxyMaxLatencyMs: number;
  /** Probe pass/fail gate: throughput below this (bps) rejects the proxy. */
  proxyMinThroughputBps: number;
  proxyFailureThreshold: number;
  proxyRetryCooldownSeconds: number;
  modelsCacheSeconds: number;
  maxAttempts: number;
  upstreamTimeoutMs: number;
}

export interface OverviewSnapshot {
  proxies: Record<ProxyStatus, number>;
  proxiesMintable: number;
  egress: {
    /** Active proxies usable for forwarding right now. */
    usable: number;
    /** Active proxies parked by an upstream 429. */
    rateLimited: number;
    /** Active proxies parked because the upstream refused the IP outright. */
    blocked: number;
    /** Conversations currently pinned to an egress. */
    pinned: number;
    /** Egresses a waiting request needs a ticket minted for. */
    mintWanted: number;
  };
  tickets: {
    available: number;
    total: number;
    /** Adaptive water mark right now; 0 means minting is paused for lack of demand. */
    target: number;
  };
  queue: {
    waiting: number;
    maxSize: number;
  };
  demand: {
    claims: number;
    windowSeconds: number;
    idleSeconds: number;
    /** True while minting is paused because no request arrived recently. */
    paused: boolean;
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
