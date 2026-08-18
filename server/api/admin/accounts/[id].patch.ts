import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { asBoolean, asNumber, asString, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) {
      throw new HttpError(400, "Account id is required.", "invalid_request_error", "id");
    }
    const body = await readJsonObject(event.req);
    const input: { label?: string; enabled?: boolean; weight?: number } = {};
    if (body.label !== undefined) {
      input.label = asString(body.label, "label", { maxLength: 120 });
    }
    if (body.enabled !== undefined) {
      input.enabled = asBoolean(body.enabled, "enabled");
    }
    if (body.weight !== undefined) {
      const weight = asNumber(body.weight, "weight", { min: 1, max: 100 });
      if (!Number.isInteger(weight)) {
        throw new HttpError(400, "`weight` must be an integer.", "invalid_request_error", "weight");
      }
      input.weight = weight;
    }
    if (Object.keys(input).length === 0) {
      throw new HttpError(400, "At least one account field must be supplied.", "invalid_request_error");
    }

    const account = await stateStore.updateAccount(id, input);
    if (input.enabled === false) {
      accountScheduler.invalidateStickyAccount(id);
    }
    return jsonResponse({ account: accountScheduler.publicState(account) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
