import { defineHandler } from "nitro";
import { asString, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const cutoff = asString(body.cutoff, "cutoff", { maxLength: 64 })!;
    return jsonResponse({ preview: usageAnalytics.previewCleanup(cutoff) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
