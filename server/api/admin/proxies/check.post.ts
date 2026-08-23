import { defineHandler } from "nitro";
import { HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const scope = body.scope ?? "error";
    if (scope !== "error" && scope !== "all") {
      throw new HttpError(400, "`scope` must be error or all.", "invalid_request_error", "scope");
    }
    const results = await proxyPoolService.checkMany(scope);
    return jsonResponse({ results, proxies: await proxyPoolService.snapshot() });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});