import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { HttpError, jsonResponse, readJsonObject } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";
import type { ProxyRecord } from "~/server/utils/types.ts";

const SCOPES = ["pending", "unavailable", "active", "all"] as const;
type Scope = (typeof SCOPES)[number];

export default defineHandler((event) => adminRoute(async (request) => {
  const body = await readJsonObject(request);
  const raw = body.scope ?? "pending";
  const scope = SCOPES.find((candidate) => candidate === raw) as Scope | undefined;
  if (!scope) {
    throw new HttpError(400, "`scope` must be pending, unavailable, active or all.", "invalid_request_error", "scope");
  }
  const runtime = gatewayRuntime();
  const records: ProxyRecord[] = scope === "all"
    ? [...runtime.proxies.listByStatus("pending"), ...runtime.proxies.listByStatus("unavailable"), ...runtime.proxies.listByStatus("active")]
    : runtime.proxies.listByStatus(scope);
  const outcome = await runtime.checker.checkAll(records);
  return jsonResponse({ ...outcome });
})(event.req));
