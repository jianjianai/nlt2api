import { defineHandler } from "nitro";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { asBoolean, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore, type ProxySettingsUpdate } from "~/server/utils/state-store.ts";

const TOOL_CALL_FORMATS = new Set(["auto", "json", "xml"]);
const PREAMBLE_VERBOSITIES = new Set(["quiet", "normal", "verbose", "milestone"]);
const MAX_MODEL_FORMAT_ENTRIES = 200;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_MINIMUM_OUTPUT_TOKENS = 8_192;
const PROXY_POOL_PROTOCOLS = new Set(["http", "socks4", "socks5"]);

function asProxyPoolSettings(value: unknown): ProxySettingsUpdate["proxyPool"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "`proxyPool` must be an object.", "invalid_request_error", "proxyPool");
  }
  const input = value as Record<string, unknown>;
  const result: NonNullable<ProxySettingsUpdate["proxyPool"]> = {};
  for (const field of ["autoAssignOnAccountCreate", "autoRotateOnTransportError", "retryCurrentRequestAfterRotation", "directFallbackWhenExhausted"] as const) {
    if (input[field] !== undefined) result[field] = asBoolean(input[field], `proxyPool.${field}`);
  }
  if (input.defaultImportProtocol !== undefined) {
    if (typeof input.defaultImportProtocol !== "string" || !PROXY_POOL_PROTOCOLS.has(input.defaultImportProtocol)) {
      throw new HttpError(400, "`proxyPool.defaultImportProtocol` must be http, socks4 or socks5.", "invalid_request_error", "proxyPool.defaultImportProtocol");
    }
    result.defaultImportProtocol = input.defaultImportProtocol as "http" | "socks4" | "socks5";
  }
  for (const [field, maximum] of [["healthCheckTimeoutSeconds", 120], ["errorRetryCooldownSeconds", 86_400]] as const) {
    const entry = input[field];
    if (entry === undefined) continue;
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > maximum) {
      throw new HttpError(400, `\`proxyPool.${field}\` must be an integer from 1 through ${maximum}.`, "invalid_request_error", `proxyPool.${field}`);
    }
    result[field] = entry;
  }
  const known = new Set([
    "autoAssignOnAccountCreate", "autoRotateOnTransportError", "retryCurrentRequestAfterRotation",
    "directFallbackWhenExhausted", "defaultImportProtocol", "healthCheckTimeoutSeconds", "errorRetryCooldownSeconds",
  ]);
  const unknown = Object.keys(input).find((field) => !known.has(field));
  if (unknown) throw new HttpError(400, `Unknown proxy-pool setting \`${unknown}\`.`, "invalid_request_error", `proxyPool.${unknown}`);
  return result;
}

const SCHEDULER_INTEGER_FIELDS = {
  accountModelConcurrency: { min: 1, max: 1_000 },
  accountRpm: { min: 1, max: 100_000 },
  proxyRpm: { min: 1, max: 100_000 },
  directEgressRpm: { min: 1, max: 100_000 },
  stickyTtlSeconds: { min: 1, max: 604_800 },
  queueTimeoutSeconds: { min: 0, max: 86_400 },
  maxQueueSize: { min: 0, max: 100_000 },
} as const;

function asSchedulerSettings(value: unknown): ProxySettingsUpdate["scheduler"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "`scheduler` must be an object.", "invalid_request_error", "scheduler");
  }
  const input = value as Record<string, unknown>;
  const result: NonNullable<ProxySettingsUpdate["scheduler"]> = {};
  for (const [field, bounds] of Object.entries(SCHEDULER_INTEGER_FIELDS)) {
    if (input[field] === undefined) continue;
    const entry = input[field];
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < bounds.min || entry > bounds.max) {
      throw new HttpError(400, `\`scheduler.${field}\` must be an integer from ${bounds.min} through ${bounds.max}.`, "invalid_request_error", `scheduler.${field}`);
    }
    (result as Record<string, unknown>)[field] = entry;
  }
  if (input.directEgressLimitEnabled !== undefined) {
    result.directEgressLimitEnabled = asBoolean(input.directEgressLimitEnabled, "scheduler.directEgressLimitEnabled");
  }
  const known = new Set([...Object.keys(SCHEDULER_INTEGER_FIELDS), "directEgressLimitEnabled"]);
  const unknown = Object.keys(input).find((field) => !known.has(field));
  if (unknown) {
    throw new HttpError(400, `Unknown scheduler setting \`${unknown}\`.`, "invalid_request_error", `scheduler.${unknown}`);
  }
  return result;
}

function asMinimumOutputTokens(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_MINIMUM_OUTPUT_TOKENS) {
    return value;
  }
  throw new HttpError(400, "`minimumOutputTokens` must be an integer from 0 through 8192.", "invalid_request_error", "minimumOutputTokens");
}

function asToolCallFormat(value: unknown): "auto" | "json" | "xml" | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && TOOL_CALL_FORMATS.has(value)) {
    return value as "auto" | "json" | "xml";
  }
  throw new HttpError(400, "`toolCallFormat` must be one of \"auto\", \"json\" or \"xml\" (or null to inherit the env default).", "invalid_request_error", "toolCallFormat");
}

function asPreambleVerbosity(value: unknown): "quiet" | "normal" | "verbose" | "milestone" | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && PREAMBLE_VERBOSITIES.has(value)) {
    return value as "quiet" | "normal" | "verbose" | "milestone";
  }
  throw new HttpError(400, "`preambleVerbosity` must be one of \"quiet\", \"normal\", \"verbose\" or \"milestone\" (or null to inherit the env default).", "invalid_request_error", "preambleVerbosity");
}

function asModelEnumMap<T extends string>(
  value: unknown,
  field: string,
  allowed: Set<string>,
): Record<string, T> | null {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `\`${field}\` must be an object mapping model ids to values.`, "invalid_request_error", field);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_MODEL_FORMAT_ENTRIES) {
    throw new HttpError(400, `\`${field}\` accepts at most ${MAX_MODEL_FORMAT_ENTRIES} entries.`, "invalid_request_error", field);
  }
  const result: Record<string, T> = {};
  for (const [key, entry] of entries) {
    const model = key.trim();
    if (!model || model.length > MAX_MODEL_ID_LENGTH) {
      throw new HttpError(400, `\`${field}\` keys must be non-empty model ids.`, "invalid_request_error", field);
    }
    if (typeof entry !== "string" || !allowed.has(entry)) {
      throw new HttpError(400, `\`${field}.${model}\` must be one of ${[...allowed].map((item) => `"${item}"`).join(", ")}.`, "invalid_request_error", field);
    }
    result[model] = entry as T;
  }
  return result;
}

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const update: ProxySettingsUpdate = {};
    if (body.proxyPool !== undefined) {
      update.proxyPool = asProxyPoolSettings(body.proxyPool);
    }
    if (body.scheduler !== undefined) {
      update.scheduler = asSchedulerSettings(body.scheduler);
    }
    if (body.recordMessages !== undefined) {
      update.recordMessages = asBoolean(body.recordMessages, "recordMessages");
    }
    if (body.minimumOutputTokens !== undefined) {
      update.minimumOutputTokens = asMinimumOutputTokens(body.minimumOutputTokens);
    }
    if (body.toolCallFormat !== undefined) {
      update.toolCallFormat = asToolCallFormat(body.toolCallFormat);
    }
    if (body.preambleVerbosity !== undefined) {
      update.preambleVerbosity = asPreambleVerbosity(body.preambleVerbosity);
    }
    if (body.modelToolCallFormats !== undefined) {
      update.modelToolCallFormats = asModelEnumMap(body.modelToolCallFormats, "modelToolCallFormats", TOOL_CALL_FORMATS);
    }
    if (body.modelPreambleVerbosities !== undefined) {
      update.modelPreambleVerbosities = asModelEnumMap(body.modelPreambleVerbosities, "modelPreambleVerbosities", PREAMBLE_VERBOSITIES);
    }
    const settings = await stateStore.updateSettings(update);
    accountScheduler.notifyStateChanged();
    return jsonResponse({ settings });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
