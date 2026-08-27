import type { DatabaseSync } from "node:sqlite";
import { SessionAffinity } from "~/server/utils/affinity.ts";
import { createInMemoryDatabase } from "~/server/utils/database.ts";
import { DemandTracker } from "~/server/utils/demand.ts";
import { ErrorLogService } from "~/server/utils/error-log.ts";
import { MintPriority } from "~/server/utils/mint-priority.ts";
import { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import { SettingsStore } from "~/server/utils/settings.ts";
import { TicketPoolService } from "~/server/utils/ticket-pool.ts";
import { TicketQueue } from "~/server/utils/ticket-queue.ts";

export interface Harness {
  db: DatabaseSync;
  settings: SettingsStore;
  errors: ErrorLogService;
  proxies: ProxyPoolService;
  tickets: TicketPoolService;
  demand: DemandTracker;
  queue: TicketQueue;
  affinity: SessionAffinity;
  mintPriority: MintPriority;
  /** Mutable clock; every service reads it through the same closure. */
  clock: { now: number };
  advance(ms: number): void;
  close(): void;
}

export function createHarness(startAt = 1_700_000_000_000): Harness {
  const db = createInMemoryDatabase();
  const clock = { now: startAt };
  const now = () => clock.now;
  const settings = new SettingsStore(db);
  const errors = new ErrorLogService(db, { now });
  const proxies = new ProxyPoolService({ db, settings, now });
  const tickets = new TicketPoolService({ db, settings, proxies, now });
  const demand = new DemandTracker({ settings, now });
  const mintPriority = new MintPriority({ now });
  const queue = new TicketQueue({
    settings,
    tickets,
    now,
    onDemand: () => demand.touch(),
    onEgressWanted: (proxyId) => mintPriority.request(proxyId),
    onEgressServed: (proxyId) => mintPriority.clear(proxyId),
  });
  const affinity = new SessionAffinity({ settings, now });
  return {
    db,
    settings,
    errors,
    proxies,
    tickets,
    demand,
    queue,
    affinity,
    mintPriority,
    clock,
    advance(ms) {
      clock.now += ms;
    },
    close() {
      db.close();
    },
  };
}

/** Imports one proxy and marks it healthy, returning its id. */
export function seedActiveProxy(harness: Harness, url = "http://1.2.3.4:8080", latencyMs = 100): string {
  harness.proxies.import(url, "http");
  const record = harness.proxies.listByStatus("pending").find((entry) => entry.url.includes(new URL(url).hostname));
  if (!record) throw new Error(`proxy ${url} was not imported`);
  harness.proxies.markHealthy(record.id, latencyMs);
  return record.id;
}
