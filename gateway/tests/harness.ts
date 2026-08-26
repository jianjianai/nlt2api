import type { DatabaseSync } from "node:sqlite";
import { createInMemoryDatabase } from "~/server/utils/database.ts";
import { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import { SettingsStore } from "~/server/utils/settings.ts";
import { TicketPoolService } from "~/server/utils/ticket-pool.ts";

export interface Harness {
  db: DatabaseSync;
  settings: SettingsStore;
  proxies: ProxyPoolService;
  tickets: TicketPoolService;
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
  const proxies = new ProxyPoolService({ db, settings, now });
  const tickets = new TicketPoolService({ db, settings, proxies, now });
  return {
    db,
    settings,
    proxies,
    tickets,
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
