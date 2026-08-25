import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { proxySyncService } from "~/server/utils/proxy-sync.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const run = proxySyncService.start("manual");
    return jsonResponse({ run }, 202);
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
