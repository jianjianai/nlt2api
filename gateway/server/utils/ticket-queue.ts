import { HttpError } from "~/server/utils/http.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { TicketPoolService } from "~/server/utils/ticket-pool.ts";
import type { TicketPair } from "~/server/utils/types.ts";

interface Waiter {
  resolve(pair: TicketPair): void;
  reject(error: unknown): void;
  settled: boolean;
  preferProxyId?: string;
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
  /** Called when a request starts waiting, so the orchestrator can mint sooner. */
  onDemand?: () => void;
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

  constructor(private readonly dependencies: TicketQueueDependencies) {}

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
   * Takes one pair, waiting in line if the pool is empty. Throws `queue_overflow`
   * when the queue is full, `queue_timeout` on expiry, and 499 if the client
   * disconnects first. `preferProxyId` is an advisory egress preference.
   */
  async acquire(signal?: AbortSignal, preferProxyId?: string): Promise<TicketPair> {
    const { settings, tickets } = this.dependencies;
    const config = settings.get();
    if (signal?.aborted) throw clientGone();
    // Only jump the line when nobody is already waiting; otherwise FIFO breaks.
    if (this.waiters.length === 0) {
      const immediate = tickets.claim(preferProxyId);
      if (immediate) return immediate;
    }
    if (this.waiters.length >= config.queueMaxSize) {
      // Queueing disabled: report the empty pool rather than a full queue.
      throw config.queueMaxSize === 0 ? poolExhausted() : queueOverflow(this.waiters.length);
    }

    this.dependencies.onDemand?.();
    return await new Promise<TicketPair>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        ...(preferProxyId ? { preferProxyId } : {}),
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
   * Hands available pairs to the head of the queue. Called after every mint and
   * on every refill tick; stops as soon as the pool runs dry again.
   */
  drain(): number {
    let served = 0;
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      const pair = this.dependencies.tickets.claim(waiter.preferProxyId);
      if (!pair) break;
      if (!this.take(waiter)) continue;
      waiter.resolve(pair);
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
