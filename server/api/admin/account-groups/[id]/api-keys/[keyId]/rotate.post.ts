import { defineHandler } from "nitro";
import { publicGroupApiKey } from "~/server/utils/account-groups.ts";
import { HttpError, jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    const keyId = event.context.params?.keyId;
    if (!id || !keyId) throw new HttpError(400, "Account group and API key ids are required.", "invalid_request_error", "id");
    const rotated = await stateStore.rotateGroupApiKey(id, keyId);
    return jsonResponse({ key: publicGroupApiKey(rotated.key), secret: rotated.secret });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
