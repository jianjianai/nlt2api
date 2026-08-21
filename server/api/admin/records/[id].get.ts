import { defineHandler } from "nitro";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) {
      throw new HttpError(400, "Record id is required.", "invalid_request_error", "id");
    }
    const record = await stateStore.getDebugRecord(id);
    if (!record) {
      throw new HttpError(404, "Record not found.", "invalid_request_error", "id");
    }
    return jsonResponse({ record });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
