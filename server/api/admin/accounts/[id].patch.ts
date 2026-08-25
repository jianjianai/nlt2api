import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { asBoolean, asNumber, asString, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { normalizeProxyUrl } from "~/server/utils/proxy.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import type { AccountSchedulerOverrides } from "~/server/utils/types.ts";

function schedulerOverrides(value: unknown, models: string[]): AccountSchedulerOverrides | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "`schedulerOverrides` must be an object or null.", "invalid_request_error", "schedulerOverrides");
  }
  const source = value as Record<string, unknown>;
  const result: AccountSchedulerOverrides = {};
  for (const [field, maximum] of [["accountRpm", 100_000], ["accountModelConcurrency", 1_000]] as const) {
    const entry = source[field];
    if (entry === undefined) continue;
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > maximum) {
      throw new HttpError(400, `\`schedulerOverrides.${field}\` must be an integer from 1 through ${maximum}.`, "invalid_request_error", `schedulerOverrides.${field}`);
    }
    result[field] = entry;
  }
  if (source.modelConcurrency !== undefined) {
    if (!source.modelConcurrency || typeof source.modelConcurrency !== "object" || Array.isArray(source.modelConcurrency)) {
      throw new HttpError(400, "`schedulerOverrides.modelConcurrency` must map model ids to concurrency limits.", "invalid_request_error", "schedulerOverrides.modelConcurrency");
    }
    const supported = new Set(models);
    const entries: Record<string, number> = {};
    for (const [rawModel, value] of Object.entries(source.modelConcurrency)) {
      const model = rawModel.trim();
      if (!supported.has(model)) {
        throw new HttpError(400, `Model \`${model}\` is not supported by this account.`, "invalid_request_error", `schedulerOverrides.modelConcurrency.${model}`);
      }
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000) {
        throw new HttpError(400, `Concurrency for \`${model}\` must be an integer from 1 through 1000.`, "invalid_request_error", `schedulerOverrides.modelConcurrency.${model}`);
      }
      entries[model] = value;
    }
    if (Object.keys(entries).length > 0) result.modelConcurrency = entries;
  }
  const known = new Set(["accountRpm", "accountModelConcurrency", "modelConcurrency"]);
  const unknown = Object.keys(source).find((field) => !known.has(field));
  if (unknown) {
    throw new HttpError(400, `Unknown account scheduler override \`${unknown}\`.`, "invalid_request_error", `schedulerOverrides.${unknown}`);
  }
  return result;
}

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const id = event.context.params?.id;
    if (!id) {
      throw new HttpError(400, "Account id is required.", "invalid_request_error", "id");
    }
    const body = await readJsonObject(event.req);
    const current = await stateStore.getAccount(id);
    if (!current) {
      throw new HttpError(404, "Account not found.", "invalid_request_error", "id");
    }
    const input: {
      label?: string;
      enabled?: boolean;
      weight?: number;
      proxy?: string | null;
      models?: string[];
      groupIds?: string[];
      schedulerOverrides?: AccountSchedulerOverrides | null;
    } = {};
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
    if (body.groupIds !== undefined) {
      if (!Array.isArray(body.groupIds) || body.groupIds.some((groupId) => typeof groupId !== "string")) {
        throw new HttpError(400, "`groupIds` must be an array of account group ids.", "invalid_request_error", "groupIds");
      }
      input.groupIds = body.groupIds as string[];
    }
    if (body.models !== undefined) {
      if (!Array.isArray(body.models) || body.models.some((model) => typeof model !== "string")) {
        throw new HttpError(400, "`models` must be an array of model id strings.", "invalid_request_error", "models");
      }
      input.models = body.models as string[];
    }
    if (body.schedulerOverrides !== undefined) {
      input.schedulerOverrides = schedulerOverrides(body.schedulerOverrides, input.models ?? current.models);
    }
    if (Object.keys(input).length === 0) {
      throw new HttpError(400, "At least one account field must be supplied.", "invalid_request_error");
    }

    let account = await stateStore.updateAccount(id, input);
    if (input.enabled === false) {
      accountScheduler.invalidateStickyAccount(id);
    }
    // Proxy changes preserve the account identity but change its stable egress.
    // The next health check/request validates DeepInfra reachability.
    accountScheduler.notifyStateChanged();
    return jsonResponse({ account: accountScheduler.publicState(account) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
