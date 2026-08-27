import { HttpError } from "~/server/utils/http.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { TicketPoolService } from "~/server/utils/ticket-pool.ts";
import type { TicketPair } from "~/server/utils/types.ts";

interface Waiter {
  resolve(pair: TicketPair): void;
  reject(error: unknown): void;
  settled: boolean;
  preferProxyId?: string;
  /** While in the future the pin is mandatory; after it any egress will do. */
  strictUntil: number;
  timer?: ReturnType<typeof setTimeout>;
  dispose(): void;
}

export function queueOverflow(waiting: number): HttpError {
  return new HttpError(
    503,
    `Too many queued requests (${waiting} waiting). The credential pool cannot keep up; retry later.`,
    "server_error",
    undefined,
    "queue_overflow",
    1,
  );
}

export function poolExhausted(): HttpError {
  return new HttpError(
    503,
    "No usable proxy/ticket pair is available. The authorization service is still replenishing the pool.",
    "server_error",
    undefined,
    "ticket_pool_empty",
    5,
  );
}

function queueTimeout(seconds: number): HttpError {
  return new HttpError(
    503,
    `Waited ${seconds}s for a credential pair without one becoming available.`,
    "server_error",
    undefined,
    "queue_timeout",
    5,
  );
}
function clientGone(): HttpError {
  return new HttpError(499, "The client disconnected while queued.", "server_error", undefined, "client_closed_request");
}

export interface TicketQueueDependencies {
  settings: SettingsStore;
  tickets: TicketPoolService;
  now?: () => number;
  /** Called when a request starts waiting, so the orchestrator can mint sooner. */
  onDemand?: () => void;
  /** Called with the egress a waiting request needs a ticket for. */
  onEgressWanted?: (proxyId: string) => void;
  /** Called once that egress delivered, so it stops being prioritised. */
  onEgressServed?: (proxyId: string) => void;
}

/**
 * FIFO admission control in front of the ticket pool.
 *
 * Requests that find the pool empty park here instead of failing, which turns a
 * burst into latency rather than a 503 storm. Order is strictly first-come so a
 * queued request cannot be starved by later arrivals, and a waiter leaves the
 * queue the moment its client disconnects — nothing is spent on a caller that is
 * already gone.
 */
export class TicketQueue {
  private readonly waiters: Waiter[] = [];
  private readonly now: () => number;

  constructor(private readonly dependencies: TicketQueueDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  waiting(): number {
    return this.waiters.length;
  }

  /**
   * Takes a pair only if one is free right now. Used by retries: a request that
   * already burned a pair must not go to the back of the queue and double its
   * own latency. Returns undefined rather than waiting, and never cuts ahead of
   * requests that are already queued.
   */
  tryClaim(preferProxyId?: string): TicketPair | undefined {
    if (this.waiters.length > 0) return undefined;
    return this.dependencies.tickets.claim(preferProxyId);
  }

  /**
   * Takes one pair, waiting in line if the pool has nothing usable.
   *
   * A pinned conversation waits for *its* egress rather than silently moving to
   * another IP: minting for that egress is requested immediately, and only after
   * `affinityWaitSeconds` does the pin relax so a slow mint cannot hold the
   * request hostage. Throws `queue_overflow` when the queue is full,
   * `queue_timeout` on expiry, and 499 if the client disconnects first.
   */
  async acquire(signal?: AbortSignal, preferProxyId?: string): Promise<TicketPair> {
    const { settings, tickets } = this.dependencies;
    const config = settings.get();
    if (signal?.aborted) throw clientGone();
    const strictMs = preferProxyId ? config.affinityWaitSeconds * 1_000 : 0;
    // Only jump the line when nobody is already waiting; otherwise FIFO breaks.
    if (this.waiters.length === 0) {
      const immediate = tickets.claim(preferProxyId, strictMs > 0);
      if (immediate) return immediate;
    }
    if (this.waiters.length >= config.queueMaxSize) {
      // Queueing disabled: report the empty pool rather than a full queue.
      throw config.queueMaxSize === 0 ? poolExhausted() : queueOverflow(this.waiters.length);
    }

    this.dependencies.onDemand?.();
    if (preferProxyId) this.dependencies.onEgressWanted?.(preferProxyId);
    return await new Promise<TicketPair>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        ...(preferProxyId ? { preferProxyId } : {}),
        strictUntil: this.now() + strictMs,
        dispose: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = () => {
        if (this.take(waiter)) reject(clientGone());
      };
      // Deliberately not unref'd: this timer is the only thing guaranteeing the
      // waiter is answered, and `rejectAll` clears it on shutdown.
      waiter.timer = setTimeout(() => {
        if (this.take(waiter)) reject(queueTimeout(config.queueTimeoutSeconds));
      }, config.queueTimeoutSeconds * 1_000);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /**
   * Hands available pairs to whoever can use them, oldest waiter first. A waiter
   * still holding a strict pin is skipped rather than blocking the queue: the
   * ticket it needs is being minted, and meanwhile someone behind it can be served.
   */
  drain(): number {
    const now = this.now();
    let served = 0;
    let dry = false;
    for (const waiter of [...this.waiters]) {
      if (dry) break;
      const strict = Boolean(waiter.preferProxyId) && waiter.strictUntil > now;
      const pair = this.dependencies.tickets.claim(waiter.preferProxyId, strict);
      if (!pair) {
        // Only an unpinned waiter finding nothing proves the pool is empty.
        if (!strict) dry = true;
        else if (waiter.preferProxyId) this.dependencies.onEgressWanted?.(waiter.preferProxyId);
        continue;
      }
      if (!this.take(waiter)) continue;
      waiter.resolve(pair);
      if (waiter.preferProxyId) this.dependencies.onEgressServed?.(waiter.preferProxyId);
      served += 1;
    }
    return served;
  }

  /** Fails everyone still waiting; used when the process is shutting down. */
  rejectAll(error: unknown): void {
    for (const waiter of [...this.waiters]) {
      if (this.take(waiter)) waiter.reject(error);
    }
  }

  /** Removes a waiter from the queue exactly once; returns false if already settled. */
  private take(waiter: Waiter): boolean {
    if (waiter.settled) return false;
    waiter.settled = true;
    waiter.dispose();
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    return true;
  }
}
