import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const [accounts, settings] = await Promise.all([
      stateStore.listAccounts(),
      stateStore.getSettings(),
    ]);
    const config = getProxyConfig();
    return jsonResponse({
      accounts: accounts.map((account) => accountScheduler.publicState(account)),
      settings,
      config: {
        adminTokenConfigured: Boolean(config.adminToken),
        clientApiKeyRequired: Boolean(config.apiKey),
        storeKeyConfigured: Boolean(config.storeKey),
        defaultModel: config.defaultModel,
      },
    });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
