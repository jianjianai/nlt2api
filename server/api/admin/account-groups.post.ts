import { defineHandler } from "nitro";
import { accountGroupAdminError } from "~/server/utils/account-groups.ts";
import { asString, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const name = asString(body.name, "name", { maxLength: 120 })!;
    const description = asString(body.description, "description", { optional: true, allowEmpty: true, maxLength: 500 });
    const group = await stateStore.createAccountGroup({ name, ...(description?.trim() ? { description } : {}) });
    return jsonResponse({ group }, 201);
  } catch (error) {
    return openAIErrorResponse(accountGroupAdminError(error));
  }
});
