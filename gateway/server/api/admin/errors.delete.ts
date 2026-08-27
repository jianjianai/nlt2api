import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { HttpError, jsonResponse, readJsonObject } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

/**
 * Clears recorded errors. `olderThanDays` (default 1) sweeps the history while
 * keeping recent entries visible; `all` wipes the journal entirely.
 */
export default defineHandler((event) => adminRoute(async (request) => {
  const body = await readJsonObject(request);
  const olderThanDays = body.olderThanDays;
  if (olderThanDays !== undefined && (typeof olderThanDays !== "number" || !Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 30)) {
    throw new HttpError(400, "`olderThanDays` must be an integer from 1 through 30.", "invalid_request_error", "olderThanDays");
  }
  if (body.all !== undefined && typeof body.all !== "boolean") {
    throw new HttpError(400, "`all` must be a boolean.", "invalid_request_error", "all");
  }
  if (body.all === true) {
    return jsonResponse({ removed: gatewayRuntime().errors.clear({ all: true }) });
  }
  return jsonResponse({ removed: gatewayRuntime().errors.clear({ olderThanDays: olderThanDays ?? 1 }) });
})(event.req));