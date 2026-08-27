import type { DemandTracker } from "~/server/utils/demand.ts";
import type { MinterHub } from "~/server/utils/minter-hub.ts";
import type { MintPriority } from "~/server/utils/mint-priority.ts";
import type { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { TicketPoolService } from "~/server/utils/ticket-pool.ts";
import type { TicketQueue } from "~/server/utils/ticket-queue.ts";

export interface RefillDeficitInput {
  /** Adaptive water mark for this pass; 0 pauses minting entirely. */
  target: number;
  available: number;
  inflight: number;
  idleActiveProxies: number;
  /** Egresses a queued request needs a ticket for but that have none. */
  priorityWanted?: number;
}

/**
 * How many new tickets to ask for right now.
 *
 * Every concurrent mint needs its own exclusive proxy lease, so the request is
 * capped by the idle active proxies minus the mints already in flight. Some of
 * those have not leased yet, so subtracting them is deliberately conservative:
 * under-dispatching costs one extra refill tick, while over-dispatching burns
 * round trips on `proxy.unavailable` replies.
 *
 * A pinned request waiting on a specific egress raises the floor: the pool can
 * look full while the one ticket that request needs does not exist.
 */
export function refillDeficit(input: RefillDeficitInput): number {
  const missing = input.target - input.available - input.inflight;
  const wanted = input.target === 0 ? 0 : (input.priorityWanted ?? 0);
  const capacity = input.idleActiveProxies - input.inflight;
  return Math.max(0, Math.min(Math.max(missing, wanted), capacity));
}

export interface RefillOrchestratorDependencies {
  settings: SettingsStore;
  proxies: ProxyPoolService;
  tickets: TicketPoolService;
  hub: MinterHub;
  demand: DemandTracker;
  queue: TicketQueue;
  mintPriority: MintPriority;
}

export class RefillOrchestrator {
  constructor(private readonly dependencies: RefillOrchestratorDependencies) {}

  /** Runs one refill pass. Returns how many mint requests were dispatched. */
  tick(): number {
    const { proxies, tickets, hub, demand, queue, mintPriority } = this.dependencies;
    // Tickets that landed since the last pass may already have a request waiting.
    queue.drain();
    if (hub.onlineCount() === 0) return 0;
    const waiting = queue.waiting();
    const deficit = refillDeficit({
      target: demand.target(waiting),
      available: tickets.availableCount(),
      inflight: hub.inflightTotal(),
      idleActiveProxies: proxies.idleActiveCount(),
      priorityWanted: tickets.egressesWithoutTicket(mintPriority.ids()).length,
    });
    return hub.dispatchMintRequests(deficit);
  }
}
