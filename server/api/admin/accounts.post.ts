import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { asNumber, asString, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth, HttpError } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { deepInfraClient } from "~/server/utils/deepinfra-client.ts";
import { normalizeProxyUrl } from "~/server/utils/proxy.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  let accountId: string | undefined;
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const label = asString(body.label, "label", { optional: true, maxLength: 120 });
    const weight = asNumber(body.weight, "weight", { optional: true, min: 1, max: 100 });
    if (weight !== undefined && !Number.isInteger(weight)) {
      throw new HttpError(400, "`weight` must be an integer.", "invalid_request_error", "weight");
    }
    const groupIds = body.groupIds === undefined ? [] : body.groupIds;
    if (!Array.isArray(groupIds) || groupIds.some((groupId) => typeof groupId !== "string")) {
      throw new HttpError(400, "`groupIds` must be an array of account group ids.", "invalid_request_error", "groupIds");
    }
    // The add-account form always submits a proxy field; an empty or
    // whitespace-only value means a direct connection.
    const proxyInput = asString(body.proxy, "proxy", { optional: true, allowEmpty: true, maxLength: 2_048 });
    const proxy = proxyInput?.trim() ? normalizeProxyUrl(proxyInput) : undefined;

    let account = await stateStore.addAccount({
      label,
      weight,
      groupIds: groupIds as string[],
      ...(proxy ? { proxy } : {}),
    });
    accountId = account.id;
    try {
      await deepInfraClient.verifyAccount(account);
      accountScheduler.markSuccess(account.id);
      account = (await stateStore.getAccount(account.id)) ?? account;
      const models = await deepInfraClient.listAccountModels(account);
      await stateStore.replaceAccountModels(account.id, models);
    } catch (error) {
      await stateStore.deleteAccount(account.id).catch(() => undefined);
      accountScheduler.remove(account.id);
      throw error;
    }

    const saved = await stateStore.getAccount(account.id);
    if (!saved) {
      throw new Error("The account disappeared after verification.");
    }
    accountScheduler.notifyStateChanged();
    return jsonResponse({ account: accountScheduler.publicState(saved) }, 201);
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
