import { defineHandler } from "nitro";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;

export default defineHandler((event) => {
  try {
    requireAdminAuth(event.req);
    const url = new URL(event.req.url);
    const now = Date.now();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const from = Date.parse(url.searchParams.get("from") ?? today.toISOString());
    const to = Date.parse(url.searchParams.get("to") ?? new Date(now).toISOString());
    const model = url.searchParams.get("model")?.trim() || undefined;
    const granularity = url.searchParams.get("granularity") ?? "hour";
    const sort = url.searchParams.get("sort") ?? "cost";
    const direction = url.searchParams.get("direction") ?? "desc";
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > MAX_RANGE_MS) {
      throw new HttpError(400, "`from` and `to` must define a valid range no longer than 366 days.", "invalid_request_error", "from");
    }
    if (to > now + 60_000) {
      throw new HttpError(400, "`to` cannot be in the future.", "invalid_request_error", "to");
    }
    if (model && model.length > 200) {
      throw new HttpError(400, "`model` is too long.", "invalid_request_error", "model");
    }
    if (!new Set(["minute", "5m", "hour", "day"]).has(granularity)) {
      throw new HttpError(400, "`granularity` must be minute, 5m, hour or day.", "invalid_request_error", "granularity");
    }
    if (!new Set(["cost", "utilization", "rpm", "tokens"]).has(sort)) {
      throw new HttpError(400, "`sort` must be cost, utilization, rpm or tokens.", "invalid_request_error", "sort");
    }
    if (direction !== "asc" && direction !== "desc") {
      throw new HttpError(400, "`direction` must be asc or desc.", "invalid_request_error", "direction");
    }
    return jsonResponse({
      result: usageAnalytics.query(new Date(from).toISOString(), new Date(to).toISOString(), {
        ...(model ? { model } : {}),
        granularity: granularity as "minute" | "5m" | "hour" | "day",
        sort: sort as "cost" | "utilization" | "rpm" | "tokens",
        direction,
      }),
      retention: usageAnalytics.getRetention(),
    });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
