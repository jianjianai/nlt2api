import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { getGatewayConfig } from "~/server/utils/config.ts";
import { jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";
import type { OverviewSnapshot } from "~/server/utils/types.ts";

export default defineHandler((event) => adminRoute(() => {
  const runtime = gatewayRuntime();
  const config = getGatewayConfig();
  const settings = runtime.settings.get();
  const snapshot: OverviewSnapshot = {
    proxies: runtime.proxies.counts(),
    proxiesMintable: runtime.proxies.mintableActiveCount(),
    tickets: {
      available: runtime.tickets.availableCount(),
      total: runtime.tickets.totalCount(),
      minAvailable: settings.minAvailableTickets,
    },
    minters: {
      online: runtime.hub.onlineCount(),
      inflight: runtime.hub.inflightTotal(),
    },
    mintRate: runtime.hub.recentRate(),
    config: {
      apiKeyConfigured: config.apiKey.length > 0,
      adminTokenConfigured: config.adminToken.length > 0,
      minterTokenConfigured: config.minterToken.length > 0,
      allowAnonymous: config.allowAnonymous,
    },
  };
  return jsonResponse({ overview: snapshot, settings });
})(event.req));
