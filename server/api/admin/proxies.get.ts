import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    return jsonResponse({ proxies: await proxyPoolService.snapshot() });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});