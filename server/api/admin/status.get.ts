import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const [accounts, settings, scheduler, proxyPool] = await Promise.all([
      stateStore.listAccounts(),
      stateStore.getSettings(),
      accountScheduler.runtimeSnapshot(),
      proxyPoolService.snapshot(),
    ]);
    const config = getProxyConfig();
    return jsonResponse({
      accounts: accounts.map((account) => accountScheduler.publicState(account)),
      settings,
      scheduler,
      proxyPool,
      config: {
        adminTokenConfigured: Boolean(config.adminToken),
        clientApiKeyRequired: Boolean(config.apiKey),
        clientApiKey: config.apiKey,
        defaultModel: config.defaultModel,
        minimumOutputTokens: config.minimumOutputTokens,
        // Env-level defaults the settings fall back to when unset.
        toolCallFormat: config.toolCallFormat,
        preambleVerbosity: config.preambleVerbosity,
      },
    });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
