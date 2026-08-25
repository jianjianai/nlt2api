import { defineHandler } from "nitro";
import { asBoolean, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import type { ProxySyncSettings } from "~/server/utils/types.ts";

const BOUNDS = {
  intervalMinutes: [5, 1_440],
  targetAccountCount: [0, 500],
  candidateLimit: [1, 2_000],
  probeConcurrency: [1, 100],
  probeTimeoutSeconds: [1, 120],
  failureThreshold: [1, 20],
  archiveCooldownHours: [1, 8_760],
} as const;

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const update: Partial<ProxySyncSettings> = {};
    if (body.enabled !== undefined) update.enabled = asBoolean(body.enabled, "enabled");
    for (const [field, [min, max]] of Object.entries(BOUNDS)) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new HttpError(400, `\`${field}\` must be an integer from ${min} through ${max}.`, "invalid_request_error", field);
      }
      (update as Record<string, unknown>)[field] = value;
    }
    const known = new Set(["enabled", ...Object.keys(BOUNDS)]);
    const unknown = Object.keys(body).find((field) => !known.has(field));
    if (unknown) throw new HttpError(400, `Unknown proxy-sync setting \`${unknown}\`.`, "invalid_request_error", unknown);
    return jsonResponse({ settings: await stateStore.updateProxySyncSettings(update) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
