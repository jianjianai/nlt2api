import type { DatabaseSync } from "node:sqlite";
import { getRow } from "~/server/utils/database.ts";
import { HttpError } from "~/server/utils/http.ts";
import type { GatewaySettings } from "~/server/utils/types.ts";

interface Bound {
  min: number;
  max: number;
}

const BOUNDS: Record<keyof GatewaySettings, Bound> = {
  // Upstream accepted a 178s-old ticket and rejected a 245s-old one, so the
  // ceiling stays under three minutes no matter what an operator types.
  ticketTtlSeconds: { min: 30, max: 178 },
  ticketMinRemainingSeconds: { min: 5, max: 60 },
  ticketCleanupIntervalSeconds: { min: 5, max: 300 },
  minAvailableTickets: { min: 1, max: 200 },
  refillIntervalSeconds: { min: 1, max: 120 },
  mintRequestTimeoutSeconds: { min: 30, max: 900 },
  proxyLeaseSeconds: { min: 30, max: 900 },
  proxyCheckIntervalSeconds: { min: 10, max: 3_600 },
  proxyCheckTimeoutSeconds: { min: 3, max: 120 },
  proxyCheckConcurrency: { min: 1, max: 32 },
  proxyFailureThreshold: { min: 1, max: 20 },
  proxyRetryCooldownSeconds: { min: 10, max: 86_400 },
  modelsCacheSeconds: { min: 0, max: 86_400 },
  maxAttempts: { min: 1, max: 10 },
  upstreamTimeoutMs: { min: 1_000, max: 600_000 },
};

export const DEFAULT_SETTINGS: GatewaySettings = {
  ticketTtlSeconds: 170,
  ticketMinRemainingSeconds: 20,
  ticketCleanupIntervalSeconds: 15,
  minAvailableTickets: 4,
  refillIntervalSeconds: 5,
  mintRequestTimeoutSeconds: 180,
  proxyLeaseSeconds: 120,
  proxyCheckIntervalSeconds: 60,
  proxyCheckTimeoutSeconds: 15,
  proxyCheckConcurrency: 4,
  proxyFailureThreshold: 3,
  proxyRetryCooldownSeconds: 300,
  modelsCacheSeconds: 300,
  maxAttempts: 3,
  upstreamTimeoutMs: 120_000,
};

const SETTINGS_KEY = "gateway";

function clamp(key: keyof GatewaySettings, value: number): number {
  const bound = BOUNDS[key];
  return Math.min(bound.max, Math.max(bound.min, Math.floor(value)));
}

function normalize(raw: unknown): GatewaySettings {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const result = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof GatewaySettings>) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = clamp(key, value);
  }
  // A ticket must outlive the freshness floor, otherwise nothing is ever claimable.
  if (result.ticketMinRemainingSeconds >= result.ticketTtlSeconds) {
    result.ticketMinRemainingSeconds = Math.max(BOUNDS.ticketMinRemainingSeconds.min, Math.floor(result.ticketTtlSeconds / 2));
  }
  return result;
}

export class SettingsStore {
  private cached: GatewaySettings | undefined;

  constructor(private readonly db: DatabaseSync) {}

  get(): GatewaySettings {
    if (this.cached) return this.cached;
    const row = getRow<{ value?: string }>(this.db, "SELECT value FROM settings WHERE key = ?", SETTINGS_KEY);
    let parsed: unknown;
    if (row?.value) {
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = undefined;
      }
    }
    this.cached = normalize(parsed);
    return this.cached;
  }

  /** Applies a partial patch; unknown keys are rejected and values must be in range. */
  patch(patch: Record<string, unknown>): GatewaySettings {
    const current = this.get();
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) {
        throw new HttpError(400, `Unknown setting \`${key}\`.`, "invalid_request_error", key);
      }
      const typed = key as keyof GatewaySettings;
      const bound = BOUNDS[typed];
      if (typeof value !== "number" || !Number.isInteger(value) || value < bound.min || value > bound.max) {
        throw new HttpError(400, `\`${key}\` must be an integer from ${bound.min} through ${bound.max}.`, "invalid_request_error", key);
      }
      next[typed] = value;
    }
    if (next.ticketMinRemainingSeconds >= next.ticketTtlSeconds) {
      throw new HttpError(
        400,
        "`ticketMinRemainingSeconds` must be smaller than `ticketTtlSeconds`.",
        "invalid_request_error",
        "ticketMinRemainingSeconds",
      );
    }
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SETTINGS_KEY, JSON.stringify(next));
    this.cached = next;
    return next;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

export function settingBounds(): Record<keyof GatewaySettings, Bound> {
  return BOUNDS;
}
