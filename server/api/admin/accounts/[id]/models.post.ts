import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { portalClient } from "~/server/utils/portal-client.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) {
      throw new HttpError(400, "Account id is required.", "invalid_request_error", "id");
    }
    const account = await stateStore.getAccount(id);
    if (!account) {
      throw new HttpError(404, "Account not found.", "invalid_request_error", "id");
    }
    // Fetch the account's current model list from the portal and append it to
    // the stored list (deduplicated), never replacing manual entries.
    const models = await portalClient.listAccountModels(account);
    const saved = await stateStore.mergeAccountModels(id, models);
    accountScheduler.markSuccess(id);
    return jsonResponse({ account: accountScheduler.publicState(saved), models });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
