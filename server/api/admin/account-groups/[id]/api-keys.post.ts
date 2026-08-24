import { defineHandler } from "nitro";
import { accountGroupAdminError, publicGroupApiKey } from "~/server/utils/account-groups.ts";
import { asString, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) throw new HttpError(400, "Account group id is required.", "invalid_request_error", "id");
    const body = await readJsonObject(event.req);
    const created = await stateStore.createGroupApiKey(id, asString(body.name, "name", { maxLength: 120 })!);
    return jsonResponse({ key: publicGroupApiKey(created.key), secret: created.secret }, 201);
  } catch (error) {
    return openAIErrorResponse(accountGroupAdminError(error));
  }
});
