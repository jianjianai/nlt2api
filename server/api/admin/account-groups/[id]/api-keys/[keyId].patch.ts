import { defineHandler } from "nitro";
import { accountGroupAdminError, publicGroupApiKey } from "~/server/utils/account-groups.ts";
import { asBoolean, asString, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    const keyId = event.context.params?.keyId;
    if (!id || !keyId) throw new HttpError(400, "Account group and API key ids are required.", "invalid_request_error", "id");
    const body = await readJsonObject(event.req);
    const input: { name?: string; enabled?: boolean } = {};
    if (body.name !== undefined) input.name = asString(body.name, "name", { maxLength: 120 });
    if (body.enabled !== undefined) input.enabled = asBoolean(body.enabled, "enabled");
    if (Object.keys(input).length === 0) throw new HttpError(400, "At least one API key field must be supplied.", "invalid_request_error");
    return jsonResponse({ key: publicGroupApiKey(await stateStore.updateGroupApiKey(id, keyId, input)) });
  } catch (error) {
    return openAIErrorResponse(accountGroupAdminError(error));
  }
});
