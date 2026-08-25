import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { jsonResponse, openAIErrorResponse, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const [accounts, settings, scheduler, proxyPool] = await Promise.all([
      stateStore.listAccounts(),
      stateStore.getSettings(),
      accountScheduler.runtimeSnapshot(),
      proxyPoolService.snapshot(),
    ]);
    const publicAccounts = accounts.map((account) => accountScheduler.publicState(account));
    const now = Date.now();
    const modelIssues = publicAccounts.flatMap((account) => Object.entries(account.runtime.modelCooldownUntil)
      .filter(([, until]) => until > now)
      .map(([model, until]) => ({ accountId: account.id, accountLabel: account.label, kind: "model" as const, model, until, ...(account.runtime.lastError ? { error: account.runtime.lastError } : {}) })));
    const accountIssues = publicAccounts
      .filter((account) => account.runtime.cooldownUntil > now)
      .map((account) => ({ accountId: account.id, accountLabel: account.label, kind: "account" as const, until: account.runtime.cooldownUntil, ...(account.runtime.lastError ? { error: account.runtime.lastError } : {}) }));
    const accountOverview = {
      total: publicAccounts.length,
      enabled: publicAccounts.filter((account) => account.enabled).length,
      sessions: publicAccounts.length,
      direct: publicAccounts.filter((account) => !account.proxy).length,
      inFlight: publicAccounts.reduce((total, account) => total + account.runtime.inFlight, 0),
      cooling: accountIssues.length,
      modelCooling: modelIssues.length,
      models: [...new Set(publicAccounts.flatMap((account) => account.models))].sort(),
      rows: publicAccounts.slice(0, 6).map((account) => ({
        id: account.id,
        label: account.label,
        proxy: Boolean(account.proxy),
        ...(account.proxyPoolEntryId ? { proxyPoolEntryId: account.proxyPoolEntryId } : {}),
        ...(account.schedulerOverrides?.accountRpm ? { accountRpm: account.schedulerOverrides.accountRpm } : {}),
        requestsLastMinute: account.runtime.requestsLastMinute,
        inFlight: account.runtime.inFlight,
      })),
      issues: [...accountIssues, ...modelIssues].slice(0, 8),
    };
    const upstreamRpm = publicAccounts.reduce((total, account) => total + account.runtime.requestsLastMinute, 0);
    const analytics = await usageAnalytics.overview(publicAccounts, settings, upstreamRpm);
    const config = getProxyConfig();
    return jsonResponse({
      accountOverview,
      settings,
      scheduler,
      analytics,
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
