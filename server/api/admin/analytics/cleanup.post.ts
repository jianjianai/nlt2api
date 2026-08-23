import { defineHandler } from "nitro";
import { asString, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const token = asString(body.token, "token", { maxLength: 128 })!;
    return jsonResponse({ deleted: usageAnalytics.cleanup(token) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
