import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const rawLimit = Number(new URL(event.req.url).searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;
    const [settings, records] = await Promise.all([
      stateStore.getSettings(),
      stateStore.listDebugRecords(limit),
    ]);
    return jsonResponse({ settings, records });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
