import { defineHandler } from "nitro";
import { HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const count = body.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 500) {
      throw new HttpError(400, "`count` must be an integer from 1 through 500.", "invalid_request_error", "count");
    }
    const result = await proxyPoolService.createAccounts(count, event.req.signal);
    const status = result.accounts.length === count ? 201 : result.accounts.length > 0 ? 207 : 409;
    return jsonResponse({
      requested: count,
      created: result.accounts.length,
      accounts: result.accounts,
      failed: result.failed,
      message: result.accounts.length === count
        ? `Created ${count} proxy accounts.`
        : `Created ${result.accounts.length} of ${count} requested accounts; not enough healthy idle proxies were available.`,
    }, status);
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
