import { defineHandler } from "nitro";
import { asBoolean, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore, type ProxySettingsUpdate } from "~/server/utils/state-store.ts";

const TOOL_CALL_FORMATS = new Set(["auto", "json", "xml"]);
const PREAMBLE_VERBOSITIES = new Set(["quiet", "normal", "verbose"]);
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

function asPreambleVerbosity(value: unknown): "quiet" | "normal" | "verbose" | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && PREAMBLE_VERBOSITIES.has(value)) {
    return value as "quiet" | "normal" | "verbose";
  }
  throw new HttpError(400, "`preambleVerbosity` must be one of \"quiet\", \"normal\" or \"verbose\" (or null to inherit the env default).", "invalid_request_error", "preambleVerbosity");
}

function asModelToolCallFormats(value: unknown): Record<string, "auto" | "json" | "xml"> | null {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "`modelToolCallFormats` must be an object mapping model ids to formats.", "invalid_request_error", "modelToolCallFormats");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_MODEL_FORMAT_ENTRIES) {
    throw new HttpError(400, `\`modelToolCallFormats\` accepts at most ${MAX_MODEL_FORMAT_ENTRIES} entries.`, "invalid_request_error", "modelToolCallFormats");
  }
  const result: Record<string, "auto" | "json" | "xml"> = {};
  for (const [key, format] of entries) {
    const model = key.trim();
    if (!model || model.length > MAX_MODEL_ID_LENGTH) {
      throw new HttpError(400, "`modelToolCallFormats` keys must be non-empty model ids.", "invalid_request_error", "modelToolCallFormats");
    }
    if (typeof format !== "string" || !TOOL_CALL_FORMATS.has(format)) {
      throw new HttpError(400, `\`modelToolCallFormats.${model}\` must be one of \"auto\", \"json\" or \"xml\".`, "invalid_request_error", "modelToolCallFormats");
    }
    result[model] = format as "auto" | "json" | "xml";
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
      update.modelToolCallFormats = asModelToolCallFormats(body.modelToolCallFormats);
    }
    return jsonResponse({ settings: await stateStore.updateSettings(update) });
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});
