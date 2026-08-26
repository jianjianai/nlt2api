import type { MinterHub } from "~/server/utils/minter-hub.ts";
import type { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { TicketPoolService } from "~/server/utils/ticket-pool.ts";

export interface RefillDeficitInput {
  minAvailable: number;
  available: number;
  inflight: number;
  idleActiveProxies: number;
}

/**
 * How many new tickets to ask for right now.
 *
 * Every concurrent mint needs its own exclusive proxy lease, so the request is
 * capped by the idle active proxies minus the mints already in flight. Some of
 * those have not leased yet, so subtracting them is deliberately conservative:
 * under-dispatching costs one extra refill tick, while over-dispatching burns
 * round trips on `proxy.unavailable` replies.
 */
export function refillDeficit(input: RefillDeficitInput): number {
  const missing = input.minAvailable - input.available - input.inflight;
  const capacity = input.idleActiveProxies - input.inflight;
  return Math.max(0, Math.min(missing, capacity));
}

export interface RefillOrchestratorDependencies {
  settings: SettingsStore;
  proxies: ProxyPoolService;
  tickets: TicketPoolService;
  hub: MinterHub;
}

export class RefillOrchestrator {
  constructor(private readonly dependencies: RefillOrchestratorDependencies) {}

  /** Runs one refill pass. Returns how many mint requests were dispatched. */
  tick(): number {
    const { settings, proxies, tickets, hub } = this.dependencies;
    if (hub.onlineCount() === 0) return 0;
    const deficit = refillDeficit({
      minAvailable: settings.get().minAvailableTickets,
      available: tickets.availableCount(),
      inflight: hub.inflightTotal(),
      idleActiveProxies: proxies.idleActiveCount(),
    });
    return hub.dispatchMintRequests(deficit);
  }
}
