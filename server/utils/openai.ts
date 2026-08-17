import { AppError } from "./errors"
import { TOOL_PROSE_FINAL_PREFIX, buildToolProtocol, encodeAssistantToolCalls, parseToolPlan, type ToolPlan } from "./tools"

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
  // Accepted but dropped: the portal tolerates these fields without any
  // semantic effect (verified in OPENAI_CHAT_COMPATIBILITY.md), and rejecting
  // them breaks clients like opencode that send them.
  "reasoning_effort",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "store",
  "metadata",
  "service_tier",
  "verbosity",
  "safety_identifier",
  "user"
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
  "presence_penalty",
  "frequency_penalty",
  "logit_bias"
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

// Parses retry blocks embedded in assistant reasoning. Legacy v1 blocks use
// the preceding display fragment; v2 continuation blocks carry the exact
// bounded assistant context sent upstream and the visible-text prefix length.
function decodeErrorBlocks(reasoning: string): {
  attempts: { assistant: boolean; reasoning: string; content: string; reason: string }[]
  remainder: string
  visibleContentChars: number
} | null {
  const attempts: { assistant: boolean; reasoning: string; content: string; reason: string }[] = []
  const pattern = /\[NWERR-START\]([\s\S]*?)\[NWERR-END\]/g
  let cursor = 0
  let visibleContentChars = 0
  let decodedBlock = false
  let match: RegExpExecArray | null
  while ((match = pattern.exec(reasoning)) !== null) {
    const blockEnd = match.index + match[0].length
    try {
      const payload = JSON.parse(match[1]) as {
        assistant?: unknown
        replay?: unknown
        reasoning?: unknown
        out?: unknown
        reason?: unknown
        visible_content_chars?: unknown
      }
      if (typeof payload.out !== "string" || typeof payload.reason !== "string") {
        cursor = blockEnd
        continue
      }
      decodedBlock = true
      if (payload.replay === "omit") {
        attempts.length = 0
        visibleContentChars = 0
        cursor = blockEnd
        continue
      }
      const displayedReasoning = reasoning.slice(cursor, match.index)
      attempts.push({
        assistant: typeof payload.assistant === "boolean" ? payload.assistant : Boolean(displayedReasoning || payload.out),
        reasoning: typeof payload.reasoning === "string" ? payload.reasoning : displayedReasoning,
        content: payload.out,
        reason: payload.reason
      })
      if (typeof payload.visible_content_chars === "number" && Number.isSafeInteger(payload.visible_content_chars) && payload.visible_content_chars >= 0) {
        visibleContentChars += payload.visible_content_chars
      }
      cursor = blockEnd
    } catch {
      // Malformed or truncated block: skip it.
      cursor = blockEnd
    }
  }
  if (!decodedBlock) return null
  return { attempts, remainder: reasoning.slice(cursor), visibleContentChars }
}

function shouldRestoreMarkedProse(plan: ToolPlan | undefined): boolean {
  return plan?.choice === "auto" && plan.finalResponseFormat === "text"
}

function invalidMessage(message: string, param: string): never {
  throw new AppError(message, 400, "invalid_message", param, "invalid_request_error")
}

function validateToolMessageSequence(messages: unknown[]): void {
  let pending: Set<string> | undefined
  let resolved = new Set<string>()
  let pendingParam = "messages"

  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index]
    if (!isRecord(item) || typeof item.role !== "string") continue

    if (pending && pending.size > 0) {
      if (item.role !== "tool") {
        return invalidMessage(
          `messages[${index}].role must be tool while responses are pending for: ${[...pending].join(", ")}`,
          `messages[${index}].role`
        )
      }

      const param = `messages[${index}].tool_call_id`
      if (typeof item.tool_call_id !== "string" || !item.tool_call_id) {
        return invalidMessage(`${param} is required for a tool message`, param)
      }
      if (!pending.has(item.tool_call_id)) {
        const detail = resolved.has(item.tool_call_id)
          ? `duplicates an earlier response for ${item.tool_call_id}`
          : `does not match any pending tool call: ${item.tool_call_id}`
        return invalidMessage(`${param} ${detail}`, param)
      }

      pending.delete(item.tool_call_id)
      resolved.add(item.tool_call_id)
      if (pending.size === 0) pending = undefined
      continue
    }

    if (item.role === "tool") {
      return invalidMessage(
        `messages[${index}] with role=tool must respond to a preceding assistant message with tool_calls`,
        `messages[${index}].tool_call_id`
      )
    }
    if (item.role !== "assistant" || !hasOwn(item, "tool_calls")) continue

    pendingParam = `messages[${index}].tool_calls`
    if (!Array.isArray(item.tool_calls) || item.tool_calls.length === 0) {
      return invalidMessage(`${pendingParam} must be a non-empty array`, pendingParam)
    }

    pending = new Set<string>()
    resolved = new Set<string>()
    for (let callIndex = 0; callIndex < item.tool_calls.length; callIndex += 1) {
      const call = item.tool_calls[callIndex]
      const param = `${pendingParam}[${callIndex}].id`
      if (!isRecord(call) || typeof call.id !== "string" || !call.id) {
        return invalidMessage(`${param} is required`, param)
      }
      if (pending.has(call.id)) {
        return invalidMessage(`${param} duplicates tool call id ${call.id}`, param)
      }
      pending.add(call.id)
    }
  }

  if (pending && pending.size > 0) {
    return invalidMessage(
      `${pendingParam} must be followed by tool messages for every tool call id; missing: ${[...pending].join(", ")}`,
      pendingParam
    )
  }
}

function normalizeMessages(value: unknown, restoreMarkedProse: boolean): JsonObject[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError("messages must be a non-empty array", 400, "invalid_messages", "messages", "invalid_request_error")
  }
  validateToolMessageSequence(value)

  return value.flatMap((item, index) => {
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
      message.content = encodeAssistantToolCalls(
        item.tool_calls,
        `messages[${index}].tool_calls`,
        hasOwn(item, "content") ? item.content : undefined
      )
    } else if (hasOwn(item, "content")) {
      const content = normalizeContent(item.content, `messages[${index}].content`)
      // Direct answers leave the relay without the marker, but must regain it
      // before returning to the model so the tool-protocol history is stable.
      message.content = restoreMarkedProse && item.role === "assistant" && !hasOwn(item, "function_call") && typeof content === "string" && content && !content.startsWith(TOOL_PROSE_FINAL_PREFIX)
        ? `${TOOL_PROSE_FINAL_PREFIX}${content}`
        : content
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
      if (typeof reasoningContent === "string") {
        const decoded = decodeErrorBlocks(reasoningContent)
        if (decoded) {
          // Re-materialize each retry as the exact assistant -> user pair sent
          // upstream. v2 also strips response text already represented by turns.
          const failedTurns = decoded.attempts.flatMap((attempt) => [
            ...(attempt.assistant ? [{
              role: "assistant",
              reasoning: attempt.reasoning || null,
              content: attempt.content || null
            }] : []),
            {
              role: "user",
              content: attempt.reason
            }
          ])
          message.reasoning = decoded.remainder || null
          if (decoded.visibleContentChars > 0 && typeof message.content === "string") {
            message.content = message.content.slice(decoded.visibleContentChars)
          }
          return [...failedTurns, message]
        }
      }
      message.reasoning = reasoningContent
    }
    return [message]
  })
}

export function validateChatRequest(input: unknown): ValidatedChatRequest {
  if (!isRecord(input)) {
    throw new AppError("The request body must be a JSON object", 400, "invalid_request", undefined, "invalid_request_error")
  }

  for (const key of Object.keys(input)) {
    if (unsupportedFields.has(key)) {
      console.warn(`[proxy] rejecting unsupported field key=${key}`)
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

  let responseFormat: "text" | "json_object" = "text"
  if (hasOwn(input, "response_format")) {
    if (!isRecord(input.response_format) || (input.response_format.type !== "text" && input.response_format.type !== "json_object")) {
      throw new AppError("Only response_format text and json_object are supported", 400, "unsupported_response_format", "response_format", "invalid_request_error")
    }
    responseFormat = input.response_format.type
  }

  const toolPlan = parseToolPlan(input, responseFormat)
  const messages = normalizeMessages(input.messages, shouldRestoreMarkedProse(toolPlan))
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

  if (toolPlan) {
    let insertionIndex = 0
    while (insertionIndex < messages.length && messages[insertionIndex].role === "system") insertionIndex += 1
    messages.splice(insertionIndex, 0, { role: "system", content: buildToolProtocol(toolPlan) })
    // XML actions use their own model-facing contract, so an upstream
    // JSON-object response constraint would conflict with every tool mode.

    // Kimi K3 reasons before emitting the XML action; a tiny client cap would
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
