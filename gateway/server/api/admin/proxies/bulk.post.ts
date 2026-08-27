import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { HttpError, jsonResponse, readJsonObject } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

const ACTIONS = ["check", "delete"] as const;
type BulkAction = (typeof ACTIONS)[number];

const MAX_IDS = 500;

export default defineHandler((event) => adminRoute(async (request) => {
  const body = await readJsonObject(request);
  const rawIds = body.ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new HttpError(400, "`ids` must be a non-empty array.", "invalid_request_error", "ids");
  }
  if (rawIds.length > MAX_IDS) {
    throw new HttpError(400, `\`ids\` must contain at most ${MAX_IDS} entries.`, "invalid_request_error", "ids");
  }
  const ids = rawIds.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (ids.length !== rawIds.length) {
    throw new HttpError(400, "`ids` must contain only strings.", "invalid_request_error", "ids");
  }
  const action = ACTIONS.find((candidate) => candidate === body.action) as BulkAction | undefined;
  if (!action) {
    throw new HttpError(400, "`action` must be check or delete.", "invalid_request_error", "action");
  }

  const runtime = gatewayRuntime();
  if (action === "delete") {
    let deleted = 0;
    for (const id of ids) {
      const record = runtime.proxies.get(id);
      if (!record) continue;
      runtime.proxies.delete(record.id);
      deleted += 1;
    }
    return jsonResponse({ deleted });
  }

  // check: probe only the proxies that still exist.
  const records = ids.map((id) => runtime.proxies.get(id)).filter((record) => record !== undefined);
  const outcome = await runtime.checker.checkAll(records);
  return jsonResponse({ ...outcome });
})(event.req));