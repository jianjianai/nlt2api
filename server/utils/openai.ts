import { AppError } from "./errors"
import type { GenerationDefaults } from "./store"
import { parseToolPlan, type ToolPlan } from "./tools"

type JsonObject = Record<string, unknown>

export const TOOL_PROTOCOL_MIN_MAX_TOKENS = 256

export interface ValidatedChatRequest {
  model: string
  stream: boolean
  includeUsage: boolean
  portalPayload: JsonObject
  toolPlan?: ToolPlan
}

const supportedFields = new Set([
  "model", "messages", "stream", "temperature", "top_p", "max_tokens", "max_completion_tokens",
  "response_format", "modalities", "stream_options", "tools", "tool_choice", "parallel_tool_calls",
  "reasoning_effort", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention", "store",
  "metadata", "service_tier", "verbosity", "safety_identifier", "user"
])
const unsupportedFields = new Set(["n", "stop", "seed", "functions", "function_call", "logprobs", "top_logprobs", "audio", "prediction", "frequency_penalty", "presence_penalty", "logit_bias"])

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function positiveInteger(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new AppError(param + " must be a positive integer", 400, "invalid_parameter", param, "invalid_request_error")
  return value
}

function finiteNumber(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AppError(param + " must be a finite number", 400, "invalid_parameter", param, "invalid_request_error")
  return value
}

function normalizeContent(value: unknown, param: string): unknown {
  if (typeof value === "string" || value === null) return value
  if (!Array.isArray(value)) throw new AppError(param + " must be a string, null, or content-part array", 400, "invalid_message", param, "invalid_request_error")
  return value.map((part, index) => {
    if (!isRecord(part) || typeof part.type !== "string") throw new AppError(param + "[" + index + "] is not a valid content part", 400, "invalid_message", param, "invalid_request_error")
    if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text }
    if (part.type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") return part
    throw new AppError(param + "[" + index + "] is unsupported", 400, "unsupported_content_part", param, "invalid_request_error")
  })
}

function normalizeMessages(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length === 0) throw new AppError("messages must be a non-empty array", 400, "invalid_messages", "messages", "invalid_request_error")
  return value.map((raw, index) => {
    const param = "messages[" + index + "]"
    if (!isRecord(raw) || typeof raw.role !== "string") throw new AppError(param + " must contain a role", 400, "invalid_message", param, "invalid_request_error")
    if (raw.role === "developer") throw new AppError("The developer role is not supported", 400, "unsupported_role", param + ".role", "invalid_request_error")
    if (!new Set(["system", "user", "assistant", "tool", "function"]).has(raw.role)) throw new AppError("The " + raw.role + " message role is unsupported", 400, "unsupported_role", param + ".role", "invalid_request_error")
    if (!hasOwn(raw, "content")) throw new AppError(param + ".content is required", 400, "invalid_message", param + ".content", "invalid_request_error")
    const message: JsonObject = { role: raw.role, content: normalizeContent(raw.content, param + ".content") }
    for (const key of ["name", "tool_call_id"]) if (hasOwn(raw, key)) message[key] = raw[key]
    if (raw.role === "assistant") {
      const reasoning = raw.reasoning_content ?? raw.reasoning
      if (reasoning !== undefined) {
        if (typeof reasoning !== "string" && reasoning !== null) throw new AppError(param + ".reasoning_content must be a string or null", 400, "invalid_message", param + ".reasoning_content", "invalid_request_error")
        message.reasoning = reasoning
      }
      if (hasOwn(raw, "tool_calls")) message.tool_calls = raw.tool_calls
    }
    return message
  })
}

export function validateChatRequest(input: unknown, defaults?: GenerationDefaults): ValidatedChatRequest {
  if (!isRecord(input)) throw new AppError("The request body must be a JSON object", 400, "invalid_request", undefined, "invalid_request_error")
  for (const key of Object.keys(input)) {
    if (unsupportedFields.has(key)) throw new AppError(key + " is not supported", 400, "unsupported_parameter", key, "invalid_request_error")
    if (!supportedFields.has(key)) throw new AppError(key + " is not supported by this adapter", 400, "unsupported_parameter", key, "invalid_request_error")
  }
  if (typeof input.model !== "string" || !input.model.trim()) throw new AppError("model is required", 400, "missing_parameter", "model", "invalid_request_error")
  const stream = input.stream === undefined ? true : input.stream
  if (typeof stream !== "boolean") throw new AppError("stream must be a boolean", 400, "invalid_parameter", "stream", "invalid_request_error")
  let responseFormat: "text" | "json_object" = "text"
  if (hasOwn(input, "response_format")) {
    if (!isRecord(input.response_format) || (input.response_format.type !== "text" && input.response_format.type !== "json_object")) throw new AppError("Only response_format text and json_object are supported", 400, "unsupported_response_format", "response_format", "invalid_request_error")
    responseFormat = input.response_format.type
  }
  const toolPlan = parseToolPlan(input, responseFormat)
  const portalPayload: JsonObject = { model: input.model, messages: normalizeMessages(input.messages), stream: false }
  if (hasOwn(input, "temperature")) portalPayload.temperature = finiteNumber(input.temperature, "temperature")
  else if (defaults?.temperature !== undefined) portalPayload.temperature = defaults.temperature
  if (hasOwn(input, "top_p")) portalPayload.top_p = finiteNumber(input.top_p, "top_p")
  else if (defaults?.topP !== undefined) portalPayload.top_p = defaults.topP
  const tokenLimit = hasOwn(input, "max_tokens")
    ? positiveInteger(input.max_tokens, "max_tokens")
    : hasOwn(input, "max_completion_tokens")
      ? positiveInteger(input.max_completion_tokens, "max_completion_tokens")
      : defaults?.maxTokens
  if (tokenLimit !== undefined) portalPayload.max_tokens = toolPlan ? Math.max(tokenLimit, TOOL_PROTOCOL_MIN_MAX_TOKENS) : tokenLimit
  if (!toolPlan && hasOwn(input, "response_format")) portalPayload.response_format = input.response_format
  if (hasOwn(input, "modalities")) {
    if (!Array.isArray(input.modalities) || input.modalities.length !== 1 || input.modalities[0] !== "text") throw new AppError("Only text modality is supported", 400, "unsupported_modality", "modalities", "invalid_request_error")
    portalPayload.modalities = ["text"]
  }
  let includeUsage = false
  if (hasOwn(input, "stream_options")) {
    if (!isRecord(input.stream_options)) throw new AppError("stream_options must be an object", 400, "invalid_parameter", "stream_options", "invalid_request_error")
    if (hasOwn(input.stream_options, "include_usage")) {
      if (typeof input.stream_options.include_usage !== "boolean") throw new AppError("stream_options.include_usage must be a boolean", 400, "invalid_parameter", "stream_options.include_usage", "invalid_request_error")
      includeUsage = input.stream_options.include_usage
    }
  }
  return { model: input.model, stream, includeUsage, portalPayload, ...(toolPlan ? { toolPlan } : {}) }
}
