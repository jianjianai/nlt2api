import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const direct = (await stateStore.listAccounts()).filter((account) => !account.proxy);
    let assigned = 0;
    let failed = 0;
    for (const account of direct) {
      try {
        const result = await proxyPoolService.assignIdle(account.id);
        if (!result) break;
        assigned += 1;
      } catch {
        failed += 1;
      }
    }
    const remaining = (await stateStore.listAccounts()).filter((account) => !account.proxy).length;
    return jsonResponse({ assigned, failed, remaining });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
