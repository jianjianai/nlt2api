import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { asNumber, asString, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth, HttpError } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { portalClient, PortalError } from "~/server/utils/portal-client.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { normalizeProxyUrl, ProxyTransportError } from "~/server/utils/proxy.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  let accountId: string | undefined;
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const email = asString(body.email, "email", { maxLength: 320 })!.trim().toLowerCase();
    const password = asString(body.password, "password", { maxLength: 4_096 })!;
    const label = asString(body.label, "label", { optional: true, maxLength: 120 });
    const weight = asNumber(body.weight, "weight", { optional: true, min: 1, max: 100 });
    if (weight !== undefined && !Number.isInteger(weight)) {
      throw new HttpError(400, "`weight` must be an integer.", "invalid_request_error", "weight");
    }
    // The add-account form always submits a proxy field; an empty or
    // whitespace-only value means a direct connection.
    const proxyInput = asString(body.proxy, "proxy", { optional: true, allowEmpty: true, maxLength: 2_048 });
    const proxy = proxyInput?.trim() ? normalizeProxyUrl(proxyInput) : undefined;

    let account = await stateStore.addAccount({ email, password, label, weight, ...(proxy ? { proxy } : {}) });
    accountId = account.id;
    if (!proxy && (await stateStore.getSettings()).proxyPool.autoAssignOnAccountCreate) {
      const assignment = await proxyPoolService.assignIdle(account.id);
      if (assignment) account = assignment.account;
    }
    try {
      await portalClient.verifyAccount(account);
      accountScheduler.markSuccess(account.id);
      // Verification may refresh and persist the session. Use the latest
      // account snapshot to avoid an unnecessary second login for model fetch.
      account = (await stateStore.getAccount(account.id)) ?? account;
      const models = await portalClient.listAccountModels(account);
      await stateStore.mergeAccountModels(account.id, models);
    } catch (error) {
      if (error instanceof ProxyTransportError) {
        await proxyPoolService.markBoundProxyError(account, error);
      }
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
    if (accountId && error instanceof PortalError) {
      return openAIErrorResponse(adminHttpError(error));
    }
    return openAIErrorResponse(adminHttpError(error));
  }
});
