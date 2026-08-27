export type WorkspaceId = "overview" | "proxies" | "tickets" | "minters" | "settings";
export type ThemeId = "light" | "dark";

export type ProxyStatus = "active" | "pending" | "unavailable";
export type ProxyKind = "http" | "socks4" | "socks5";
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
  failureCount: number;
  lastError?: string;
  retryAfter?: number;
  rateLimitedUntil?: number;
  lastUsedAt?: number;
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
  rateLimitCooldownSeconds: number;
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

export type SettingKey = keyof GatewaySettings;
export type SettingBounds = Record<SettingKey, { min: number; max: number }>;

export interface OverviewSnapshot {
  proxies: Record<ProxyStatus, number>;
  proxiesMintable: number;
  egress: { usable: number; rateLimited: number; pinned: number };
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
}
