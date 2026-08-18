import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const accounts = await stateStore.listAccounts();
    return jsonResponse({ accounts: accounts.map((account) => accountScheduler.publicState(account)) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
