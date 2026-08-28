export type WorkspaceId = "overview" | "proxies" | "tickets" | "minters" | "errors" | "settings";
export type ThemeId = "light" | "dark";

/** Which subsystem the error belongs to: ticket minting versus request forwarding. */
export type ErrorLogKind = "minter" | "forward";

/** `failed` is an outright error; `rejected` means a soft refusal by the upstream. */
export type ErrorLogStatus = "failed" | "rejected";

export interface ErrorLogEntry {
  id: number;
  at: number;
  kind: ErrorLogKind;
  status: ErrorLogStatus;
  message: string;
  sessionId?: string;
  proxyId?: string;
  agentId?: string;
  attempt?: number;
  /** Upstream HTTP status, when the failure came from the upstream API. */
  upstreamStatus?: number;
  /** Upstream response body, verbatim (after redaction) for diagnosis. */
  upstreamBody?: string;
}

export interface ErrorLogSummary extends Record<ErrorLogKind, Record<ErrorLogStatus, number>> {}

export type ProxyStatus = "active" | "pending" | "unavailable" | "rejected";
export type ProxyKind = "http" | "socks4" | "socks5";
export type ProxyCooldownReason = "rate_limit" | "ip_blocked";
export type ProxyFilter = "all" | ProxyStatus;

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
  mintable: boolean;
  availableTickets: number;
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

export interface MinterSessionPublic {
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
  online: boolean;
  inflight: number;
  leases: number;
}

export interface GatewaySettings {
  ticketTtlSeconds: number;
  ticketMinRemainingSeconds: number;
  ticketCleanupIntervalSeconds: number;
  minAvailableTickets: number;
  maxAvailableTickets: number;
  targetLeadSeconds: number;
  demandWindowSeconds: number;
  idleAfterSeconds: number;
  queueMaxSize: number;
  queueTimeoutSeconds: number;
  affinityTtlSeconds: number;
  affinityWaitSeconds: number;
  rateLimitCooldownSeconds: number;
  ipBlockCooldownSeconds: number;
  refillIntervalSeconds: number;
  mintRequestTimeoutSeconds: number;
  proxyLeaseSeconds: number;
  stickyMintsMin: number;
  stickyMintsMax: number;
  proxyCheckIntervalSeconds: number;
  proxyCheckTimeoutSeconds: number;
  proxyCheckConcurrency: number;
  proxyMaxLatencyMs: number;
  proxyMinThroughputBps: number;
  proxyFailureThreshold: number;
  proxyRetryCooldownSeconds: number;
  modelsCacheSeconds: number;
  maxAttempts: number;
  upstreamTimeoutMs: number;
}

export type SettingKey = keyof GatewaySettings;
export type SettingBounds = Record<SettingKey, { min: number; max: number }>;

export interface OverviewSnapshot {
  proxies: Record<ProxyStatus, number>;
  proxiesMintable: number;
  egress: { usable: number; rateLimited: number; blocked: number; pinned: number; mintWanted: number };
  tickets: { available: number; total: number; target: number };
  queue: { waiting: number; maxSize: number };
  demand: { claims: number; windowSeconds: number; idleSeconds: number; paused: boolean };
  minters: { online: number; inflight: number };
  mintRate: { minted: number; failed: number; windowMinutes: number };
  config: {
    apiKeyConfigured: boolean;
    adminTokenConfigured: boolean;
    minterTokenConfigured: boolean;
    allowAnonymous: boolean;
  };
}

export interface ImportSummary {
  imported: number;
  duplicates: number;
  invalid: Array<{ line: string; message: string }>;
}

export interface CheckOutcome {
  checked: number;
  healthy: number;
  /** Present on the single-proxy check; the proxy state right after probing. */
  proxy?: ProxyPublic | null;
}
