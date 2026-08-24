import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const [groups, accounts] = await Promise.all([
      stateStore.listAccountGroups(),
      stateStore.listAccounts(),
    ]);
    return jsonResponse({
      groups,
      groupSummary: {
        totalAccounts: accounts.length,
        ungroupedAccounts: accounts.filter((account) => account.groupIds.length === 0).length,
      },
    });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
