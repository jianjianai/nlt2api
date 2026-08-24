import { defineHandler } from "nitro";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    const keyId = event.context.params?.keyId;
    if (!id || !keyId) throw new HttpError(400, "Account group and API key ids are required.", "invalid_request_error", "id");
    await stateStore.deleteGroupApiKey(id, keyId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
