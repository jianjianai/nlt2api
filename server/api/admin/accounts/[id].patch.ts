import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { asBoolean, asNumber, asString, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { normalizeProxyUrl } from "~/server/utils/proxy.ts";
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
    const input: { label?: string; enabled?: boolean; weight?: number; proxy?: string | null } = {};
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
    if (body.proxy !== undefined) {
      // null, empty and whitespace-only values all clear the proxy.
      const proxyInput = body.proxy === null
        ? null
        : asString(body.proxy, "proxy", { allowEmpty: true, maxLength: 2_048 });
      input.proxy = proxyInput?.trim() ? normalizeProxyUrl(proxyInput) : null;
    }
    if (Object.keys(input).length === 0) {
      throw new HttpError(400, "At least one account field must be supplied.", "invalid_request_error");
    }

    let account = await stateStore.updateAccount(id, input);
    if (input.enabled === false) {
      accountScheduler.invalidateStickyAccount(id);
    }
    if (input.proxy !== undefined) {
      // The portal session may be bound to the previous egress IP, so force a
      // fresh login through the updated proxy on the next request.
      await stateStore.updateSession(id, undefined);
      account = (await stateStore.getAccount(id)) ?? account;
    }
    return jsonResponse({ account: accountScheduler.publicState(account) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
