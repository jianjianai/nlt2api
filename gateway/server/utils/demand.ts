import type { SettingsStore } from "~/server/utils/settings.ts";

export interface AdaptiveTargetInput {
  /** Pairs demanded within the trailing window; retries count individually. */
  claims: number;
  windowSeconds: number;
  targetLeadSeconds: number;
  waiting: number;
  minAvailable: number;
  maxAvailable: number;
  idle: boolean;
}

/**
 * The water mark the pool should hold right now.
 *
 * Sizing is `demand rate × lead time`: at the measured consumption rate the
 * standing pool covers `targetLeadSeconds` of traffic, which is the window the
 * minters need to replace what was spent. Queued requests are added on top
 * because they are unmet demand the rate has not observed yet. Returns 0 while
 * idle, which pauses minting instead of burning proxies on tickets nobody claims.
 */
export function adaptiveTarget(input: AdaptiveTargetInput): number {
  if (input.idle) return 0;
  const perSecond = input.claims / Math.max(1, input.windowSeconds);
  const lead = Math.ceil(perSecond * input.targetLeadSeconds);
  const ceiling = Math.max(input.minAvailable, input.maxAvailable);
  return Math.min(ceiling, Math.max(input.minAvailable, lead + input.waiting));
}

export interface DemandSnapshot {
  claims: number;
  windowSeconds: number;
  idleSeconds: number;
  paused: boolean;
  target: number;
}

export interface DemandTrackerDependencies {
  settings: SettingsStore;
  now?: () => number;
}

/**
 * In-memory record of how fast requests consume pairs. Deliberately not
 * persisted: after a restart the pool is empty anyway, so a cold start should
 * measure the live traffic rather than replay yesterday's.
 */
export class DemandTracker {
  private readonly settings: SettingsStore;
  private readonly now: () => number;
  private readonly events: number[] = [];
  private lastRequestAt: number;

  constructor(dependencies: DemandTrackerDependencies) {
    this.settings = dependencies.settings;
    this.now = dependencies.now ?? Date.now;
    // Startup counts as activity so a fresh process primes the pool once and the
    // first request does not have to wait for a cold mint.
    this.lastRequestAt = this.now();
  }

  /** A client request arrived; keeps minting awake even if it ends up queued. */
  touch(): void {
    this.lastRequestAt = this.now();
  }

  /** One pair was taken from the pool. Every forward attempt spends exactly one. */
  record(): void {
    const now = this.now();
    this.lastRequestAt = now;
    this.events.push(now);
    this.prune(now);
  }

  claimsInWindow(): number {
    const now = this.now();
    this.prune(now);
    return this.events.length;
  }

  idleMs(): number {
    return Math.max(0, this.now() - this.lastRequestAt);
  }

  /** True while minting is paused for lack of recent demand. */
  paused(waiting: number): boolean {
    const { idleAfterSeconds } = this.settings.get();
    if (idleAfterSeconds === 0 || waiting > 0) return false;
    return this.idleMs() > idleAfterSeconds * 1_000;
  }

  /** The adaptive water mark; 0 means minting is paused. */
  target(waiting: number): number {
    const settings = this.settings.get();
    return adaptiveTarget({
      claims: this.claimsInWindow(),
      windowSeconds: settings.demandWindowSeconds,
      targetLeadSeconds: settings.targetLeadSeconds,
      waiting,
      minAvailable: settings.minAvailableTickets,
      maxAvailable: settings.maxAvailableTickets,
      idle: this.paused(waiting),
    });
  }

  snapshot(waiting: number): DemandSnapshot {
    return {
      claims: this.claimsInWindow(),
      windowSeconds: this.settings.get().demandWindowSeconds,
      idleSeconds: Math.floor(this.idleMs() / 1_000),
      paused: this.paused(waiting),
      target: this.target(waiting),
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.settings.get().demandWindowSeconds * 1_000;
    let drop = 0;
    while (drop < this.events.length && this.events[drop]! < cutoff) drop += 1;
    if (drop > 0) this.events.splice(0, drop);
  }
}
