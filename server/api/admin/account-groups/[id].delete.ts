import { defineHandler } from "nitro";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) throw new HttpError(400, "Account group id is required.", "invalid_request_error", "id");
    if (!await stateStore.getAccountGroup(id)) throw new HttpError(404, "Account group not found.", "invalid_request_error", "id");
    const affected = await stateStore.deleteAccountGroup(id);
    return jsonResponse({ deleted: true, affected });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
