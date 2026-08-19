import { defineHandler } from "nitro";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const accountId = new URL(event.req.url).searchParams.get("account_id")?.trim();
    if (!accountId || accountId.length > 128) {
      throw new HttpError(400, "`account_id` is required.", "invalid_request_error", "account_id");
    }
    const deleted = await stateStore.deleteDebugRecordsForAccount(accountId);
    return jsonResponse({ deleted });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
