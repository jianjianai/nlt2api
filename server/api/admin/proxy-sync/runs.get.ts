import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    return jsonResponse({ runs: await stateStore.listProxySyncRuns() });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
