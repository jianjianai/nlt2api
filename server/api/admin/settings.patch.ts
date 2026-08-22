import { defineHandler } from "nitro";
import { asBoolean, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore, type ProxySettingsUpdate } from "~/server/utils/state-store.ts";

const TOOL_CALL_FORMATS = new Set(["auto", "json", "xml"]);
const PREAMBLE_VERBOSITIES = new Set(["quiet", "normal", "verbose", "milestone"]);
const MAX_MODEL_FORMAT_ENTRIES = 200;
const MAX_MODEL_ID_LENGTH = 200;

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
    if (body.recordMessages !== undefined) {
      update.recordMessages = asBoolean(body.recordMessages, "recordMessages");
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
    return jsonResponse({ settings: await stateStore.updateSettings(update) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
