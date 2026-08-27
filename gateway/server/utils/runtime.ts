import { readFileSync } from "node:fs";
import { SessionAffinity } from "~/server/utils/affinity.ts";
import { gatewayDatabase } from "~/server/utils/database.ts";
import { DemandTracker } from "~/server/utils/demand.ts";
import { ForwardService } from "~/server/utils/forward-service.ts";
import { MinterHub } from "~/server/utils/minter-hub.ts";
import { MintPriority } from "~/server/utils/mint-priority.ts";
import { ProxyChecker } from "~/server/utils/proxy-checker.ts";
import { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import { RefillOrchestrator } from "~/server/utils/refill-orchestrator.ts";
import { SettingsStore } from "~/server/utils/settings.ts";
import { TicketPoolService } from "~/server/utils/ticket-pool.ts";
import { TicketQueue } from "~/server/utils/ticket-queue.ts";

export interface GatewayRuntime {
  settings: SettingsStore;
  proxies: ProxyPoolService;
  tickets: TicketPoolService;
  queue: TicketQueue;
  demand: DemandTracker;
  affinity: SessionAffinity;
  mintPriority: MintPriority;
  hub: MinterHub;
  checker: ProxyChecker;
  refill: RefillOrchestrator;
  forward: ForwardService;
}

function serverVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let runtime: GatewayRuntime | undefined;

export function gatewayRuntime(): GatewayRuntime {
  if (runtime) return runtime;
  const db = gatewayDatabase();
  const settings = new SettingsStore(db);
  const proxies = new ProxyPoolService({ db, settings });
  const tickets = new TicketPoolService({ db, settings, proxies });
  const demand = new DemandTracker({ settings });
  const affinity = new SessionAffinity({ settings });
  const mintPriority = new MintPriority();
  // The refill loop reads the queue depth, so the queue only has to nudge demand.
  const queue = new TicketQueue({
    settings,
    tickets,
    onDemand: () => demand.touch(),
    onEgressWanted: (proxyId) => mintPriority.request(proxyId),
    onEgressServed: (proxyId) => mintPriority.clear(proxyId),
  });
  const hub = new MinterHub({
    db,
    settings,
    proxies,
    tickets,
    serverVersion: serverVersion(),
    onTicketAccepted: () => queue.drain(),
    mintPriority: () => mintPriority.ids(),
  });
  const checker = new ProxyChecker({ settings, proxies });
  const refill = new RefillOrchestrator({ settings, proxies, tickets, hub, demand, queue, mintPriority });
  const forward = new ForwardService({ settings, proxies, tickets, queue, demand, affinity });
  runtime = { settings, proxies, tickets, queue, demand, affinity, mintPriority, hub, checker, refill, forward };
  return runtime;
}

export function resetGatewayRuntimeForTests(): void {
  runtime = undefined;
}
