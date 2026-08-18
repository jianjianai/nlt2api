import { defineHandler } from "nitro";
import { asBoolean, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const recordMessages = body.recordMessages === undefined
      ? undefined
      : asBoolean(body.recordMessages, "recordMessages");
    return jsonResponse({ settings: await stateStore.updateSettings({ recordMessages }) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
