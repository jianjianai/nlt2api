import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) throw new HttpError(400, "Account id is required.", "invalid_request_error", "id");
    const account = await stateStore.getAccount(id);
    if (!account) throw new HttpError(404, "Account not found.", "invalid_request_error", "id");
    if (account.proxy) throw new HttpError(409, "Account already has a proxy.", "invalid_request_error", "id", "account_has_proxy");
    const assignment = await proxyPoolService.assignIdle(id);
    if (!assignment) throw new HttpError(409, "No healthy idle proxy is available.", "invalid_request_error", "id", "no_idle_proxy");
    const proxy = (await proxyPoolService.snapshot()).find((entry) => entry.id === assignment.entry?.id);
    return jsonResponse({ account: accountScheduler.publicState(assignment.account), proxy });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});