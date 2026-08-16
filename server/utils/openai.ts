import { AppError } from "./errors"
import { buildToolProtocol, encodeAssistantToolCalls, parseToolPlan, type ToolPlan } from "./tools"

type JsonObject = Record<string, unknown>

// The Kimi reasoning path spends output tokens on thinking before the JSON
// action; below this floor a tool request is likely to return no action.
export const TOOL_PROTOCOL_MIN_MAX_TOKENS = 256

export interface ValidatedChatRequest {
  model: string
  stream: boolean
  includeUsage: boolean
  portalPayload: JsonObject
  toolPlan?: ToolPlan
}

const supportedFields = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "response_format",
  "modalities",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  // Accepted but dropped: the portal accepts reasoning_effort without any
  // reasoning-control semantics (verified in OPENAI_CHAT_COMPATIBILITY.md),
  // and rejecting it breaks clients like opencode that send it.
  "reasoning_effort"
])

const unsupportedFields = new Set([
  "n",
  "stop",
  "seed",
  "functions",
  "function_call",
  "logprobs",
  "top_logprobs",
  "audio",
  "web_search_options",
  "prediction",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "store",
  "metadata",
  "safety_identifier",
  "service_tier",
  "verbosity",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "user"
])

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOwn(record: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function assertFiniteNumber(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(`${param} must be a finite number`, 400, "invalid_parameter", param, "invalid_request_error")
  }
  return value
}

function assertPositiveInteger(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AppError(`${param} must be a positive integer`, 400, "invalid_parameter", param, "invalid_request_error")
  }
  return value
}

function normalizeContent(content: unknown, param: string): unknown {
  if (typeof content === "string" || content === null) {
    return content
  }

  if (!Array.isArray(content)) {
    throw new AppError(`${param} must be a string or content-part array`, 400, "invalid_message", param, "invalid_request_error")
  }

  return content.map((part, index) => {
    if (!isRecord(part) || typeof part.type !== "string") {
      throw new AppError(`${param}[${index}] is not a valid content part`, 400, "invalid_message", param, "invalid_request_error")
    }

    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new AppError(`${param}[${index}].text must be a string`, 400, "invalid_message", param, "invalid_request_error")
      }
      return { type: "text", text: part.text }
    }

    if (part.type === "image_url") {
      if (!isRecord(part.image_url) || typeof part.image_url.url !== "string") {
        throw new AppError(`${param}[${index}].image_url.url is required`, 400, "invalid_message", param, "invalid_request_error")
      }
      return part
    }

    throw new AppError(`${param}[${index}].type=${part.type} is unsupported`, 400, "unsupported_content_part", param, "invalid_request_error")
  })
}

function normalizeMessages(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError("messages must be a non-empty array", 400, "invalid_messages", "messages", "invalid_request_error")
  }

  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.role !== "string") {
      throw new AppError(`messages[${index}] must contain a role`, 400, "invalid_message", `messages[${index}]`, "invalid_request_error")
    }

    if (item.role === "developer") {
      throw new AppError("The developer role is not supported by /api/chat", 400, "unsupported_role", `messages[${index}].role`, "invalid_request_error")
    }

    const allowedRoles = new Set(["system", "user", "assistant", "tool", "function"])
    if (!allowedRoles.has(item.role)) {
      throw new AppError(`The ${item.role} message role is unsupported`, 400, "unsupported_role", `messages[${index}].role`, "invalid_request_error")
    }

    const message: JsonObject = { role: item.role }
    if (item.role === "assistant" && hasOwn(item, "tool_calls")) {
      message.content = encodeAssistantToolCalls(item.tool_calls, `messages[${index}].tool_calls`)
    } else if (hasOwn(item, "content")) {
      message.content = normalizeContent(item.content, `messages[${index}].content`)
    } else {
      throw new AppError(`messages[${index}].content is required`, 400, "invalid_message", `messages[${index}].content`, "invalid_request_error")
    }

    for (const key of ["name", "tool_call_id", "function_call"]) {
      if (hasOwn(item, key)) {
        message[key] = item[key]
      }
    }

    if (item.role === "assistant" && (hasOwn(item, "reasoning_content") || hasOwn(item, "reasoning"))) {
      const reasoningContent = hasOwn(item, "reasoning_content") ? item.reasoning_content : item.reasoning
      if (typeof reasoningContent !== "string" && reasoningContent !== null) {
        throw new AppError(`messages[${index}].reasoning_content must be a string or null`, 400, "invalid_message", `messages[${index}].reasoning_content`, "invalid_request_error")
      }
      message.reasoning = reasoningContent
    }
    return message
  })
}

export function validateChatRequest(input: unknown): ValidatedChatRequest {
  if (!isRecord(input)) {
    throw new AppError("The request body must be a JSON object", 400, "invalid_request", undefined, "invalid_request_error")
  }

  for (const key of Object.keys(input)) {
    if (unsupportedFields.has(key)) {
      throw new AppError(`${key} is not supported by /api/chat`, 400, "unsupported_parameter", key, "invalid_request_error")
    }
    if (!supportedFields.has(key)) {
      throw new AppError(`${key} is not supported by this compatibility adapter`, 400, "unsupported_parameter", key, "invalid_request_error")
    }
  }

  if (typeof input.model !== "string" || !input.model.trim()) {
    throw new AppError("model is required", 400, "missing_parameter", "model", "invalid_request_error")
  }

  const stream = input.stream === undefined ? false : input.stream
  if (typeof stream !== "boolean") {
    throw new AppError("stream must be a boolean", 400, "invalid_parameter", "stream", "invalid_request_error")
  }

  const messages = normalizeMessages(input.messages)
  const portalPayload: JsonObject = {
    model: input.model,
    messages,
    stream
  }

  for (const key of ["temperature", "top_p"]) {
    if (hasOwn(input, key)) {
      portalPayload[key] = assertFiniteNumber(input[key], key)
    }
  }

  const maxTokens = hasOwn(input, "max_tokens") ? assertPositiveInteger(input.max_tokens, "max_tokens") : undefined
  const maxCompletionTokens = hasOwn(input, "max_completion_tokens")
    ? assertPositiveInteger(input.max_completion_tokens, "max_completion_tokens")
    : undefined
  if (maxTokens !== undefined && maxCompletionTokens !== undefined && maxTokens !== maxCompletionTokens) {
    throw new AppError("max_tokens and max_completion_tokens must match when both are provided", 400, "conflicting_parameters", "max_completion_tokens", "invalid_request_error")
  }
  if (maxTokens !== undefined || maxCompletionTokens !== undefined) {
    portalPayload.max_tokens = maxTokens ?? maxCompletionTokens
  }

  let responseFormat: "text" | "json_object" = "text"
  if (hasOwn(input, "response_format")) {
    if (!isRecord(input.response_format) || (input.response_format.type !== "text" && input.response_format.type !== "json_object")) {
      throw new AppError("Only response_format text and json_object are supported", 400, "unsupported_response_format", "response_format", "invalid_request_error")
    }
    responseFormat = input.response_format.type
  }

  const toolPlan = parseToolPlan(input, responseFormat)
  if (toolPlan) {
    let insertionIndex = 0
    while (insertionIndex < messages.length && messages[insertionIndex].role === "system") insertionIndex += 1
    messages.splice(insertionIndex, 0, { role: "system", content: buildToolProtocol(toolPlan) })
    portalPayload.response_format = { type: "json_object" }

    // Kimi K3 reasons before emitting the JSON action; a tiny client cap would
    // spend the whole budget on thinking and return no action at all.
    const maxTokens = portalPayload.max_tokens
    if (typeof maxTokens === "number" && maxTokens < TOOL_PROTOCOL_MIN_MAX_TOKENS) {
      console.info(`[proxy] raised max_tokens ${maxTokens} -> ${TOOL_PROTOCOL_MIN_MAX_TOKENS} for tool protocol`)
      portalPayload.max_tokens = TOOL_PROTOCOL_MIN_MAX_TOKENS
    }
  } else if (hasOwn(input, "response_format")) {
    portalPayload.response_format = input.response_format
  }

  if (hasOwn(input, "modalities")) {
    if (!Array.isArray(input.modalities) || input.modalities.length !== 1 || input.modalities[0] !== "text") {
      throw new AppError("Only text modality is supported", 400, "unsupported_modality", "modalities", "invalid_request_error")
    }
    portalPayload.modalities = ["text"]
  }

  let includeUsage = false
  if (hasOwn(input, "stream_options")) {
    if (!isRecord(input.stream_options)) {
      throw new AppError("stream_options must be an object", 400, "invalid_parameter", "stream_options", "invalid_request_error")
    }
    if (hasOwn(input.stream_options, "include_obfuscation")) {
      throw new AppError("stream_options.include_obfuscation is not supported", 400, "unsupported_parameter", "stream_options.include_obfuscation", "invalid_request_error")
    }
    if (hasOwn(input.stream_options, "include_usage")) {
      if (typeof input.stream_options.include_usage !== "boolean") {
        throw new AppError("stream_options.include_usage must be a boolean", 400, "invalid_parameter", "stream_options.include_usage", "invalid_request_error")
      }
      includeUsage = input.stream_options.include_usage
    }
  }

  return { model: input.model, stream, includeUsage, portalPayload, ...(toolPlan ? { toolPlan } : {}) }
}
