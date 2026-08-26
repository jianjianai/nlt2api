import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler((event) => adminRoute((request) => {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "100") || 100;
  const runtime = gatewayRuntime();
  return jsonResponse({
    entries: runtime.tickets.snapshot(limit),
    available: runtime.tickets.availableCount(),
    total: runtime.tickets.totalCount(),
  });
})(event.req));
