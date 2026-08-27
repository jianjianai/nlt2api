import { defineHandler } from "nitro";
import { adminRoute, pagination } from "~/server/utils/admin-route.ts";
import { jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";
import type { ProxyStatus } from "~/server/utils/types.ts";

const STATUSES: ProxyStatus[] = ["active", "pending", "unavailable", "rejected"];

export default defineHandler((event) => adminRoute((request) => {
  const url = new URL(request.url);
  const raw = url.searchParams.get("status");
  const status = STATUSES.find((candidate) => candidate === raw);
  const { limit, offset } = pagination(request);
  const snapshot = gatewayRuntime().proxies.snapshot({ ...(status ? { status } : {}), limit, offset });
  return jsonResponse({ ...snapshot, limit, offset });
})(event.req));
