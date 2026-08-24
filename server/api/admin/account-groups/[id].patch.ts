import { defineHandler } from "nitro";
import { accountGroupAdminError } from "~/server/utils/account-groups.ts";
import { asBoolean, asString, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) throw new HttpError(400, "Account group id is required.", "invalid_request_error", "id");
    const body = await readJsonObject(event.req);
    const input: { name?: string; description?: string | null; enabled?: boolean } = {};
    if (body.name !== undefined) input.name = asString(body.name, "name", { maxLength: 120 });
    if (body.description === null) input.description = null;
    else if (body.description !== undefined) input.description = asString(body.description, "description", { allowEmpty: true, maxLength: 500 }) ?? null;
    if (body.enabled !== undefined) input.enabled = asBoolean(body.enabled, "enabled");
    if (Object.keys(input).length === 0) throw new HttpError(400, "At least one account group field must be supplied.", "invalid_request_error");
    return jsonResponse({ group: await stateStore.updateAccountGroup(id, input) });
  } catch (error) {
    return openAIErrorResponse(accountGroupAdminError(error));
  }
});
