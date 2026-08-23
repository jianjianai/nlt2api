import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    await usageAnalytics.refreshPrices(true);
    return jsonResponse({ refreshed: true });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
