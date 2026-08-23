import { defineHandler } from "nitro";
import { HttpError, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) throw new HttpError(400, "Proxy id is required.", "invalid_request_error", "id");
    try {
      await proxyPoolService.delete(id);
    } catch (error) {
      if (error instanceof Error && /assigned/.test(error.message)) {
        throw new HttpError(409, "Proxy is assigned to an account.", "invalid_request_error", "id", "proxy_in_use");
      }
      if (error instanceof Error && /being checked/.test(error.message)) {
        throw new HttpError(409, "Proxy is currently being checked.", "invalid_request_error", "id", "proxy_checking");
      }
      if (error instanceof Error && /not found/.test(error.message)) {
        throw new HttpError(404, "Proxy pool entry not found.", "invalid_request_error", "id", "proxy_not_found");
      }
      throw error;
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});