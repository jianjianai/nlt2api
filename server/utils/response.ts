import { randomUUID } from "node:crypto"
import { AppError } from "./errors"
import { parseToolAction, type ParsedToolAction, type ToolPlan } from "./tools"

type JsonObject = Record<string, unknown>

export class UpstreamStreamError extends Error {
  readonly isAuthError: boolean

  constructor(message: string, isAuthError = false) {
    super(message)
    this.name = "UpstreamStreamError"
    this.isAuthError = isAuthError
  }
}

export interface PreparedSse {
  reader: ReadableStreamDefaultReader<Uint8Array>
  pending: string
  firstChunk?: JsonObject
  firstDone: boolean
  firstError?: UpstreamStreamError
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asMessage(value: unknown): string {
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.message === "string") return value.message
  return "The upstream chat request failed"
}

function isAuthMessage(message: string): boolean {
  return /unauthor|authentication|session|login|cookie|csrf|token/i.test(message)
}

function takeFrame(buffer: string): { frame: string; rest: string } | null {
  const lfIndex = buffer.indexOf("\n\n")
  const crlfIndex = buffer.indexOf("\r\n\r\n")
  if (lfIndex < 0 && crlfIndex < 0) return null

  const useCrlf = crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)
  const index = useCrlf ? crlfIndex : lfIndex
  const separatorLength = useCrlf ? 4 : 2
  return { frame: buffer.slice(0, index), rest: buffer.slice(index + separatorLength) }
}

function dataFromFrame(frame: string): string | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
  return dataLines.length > 0 ? dataLines.join("\n") : null
}

function parseData(data: string): JsonObject | "DONE" {
  if (data.trim() === "[DONE]") return "DONE"
  try {
    const parsed: unknown = JSON.parse(data)
    if (!isRecord(parsed)) throw new Error("not an object")
    if (parsed.error !== undefined) {
      const message = asMessage(parsed.error)
      throw new UpstreamStreamError(message, isAuthMessage(message))
    }
    return parsed
  } catch (error) {
    if (error instanceof UpstreamStreamError) throw error
    throw new UpstreamStreamError("The upstream returned invalid SSE JSON")
  }
}

export async function prepareSse(body: ReadableStream<Uint8Array> | null): Promise<PreparedSse> {
  if (!body) {
    throw new AppError("The upstream returned an empty streaming body", 502, "empty_upstream_body")
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  while (true) {
    const frame = takeFrame(pending)
    if (frame) {
      pending = frame.rest
      const data = dataFromFrame(frame.frame)
      if (!data) continue
      try {
        const parsed = parseData(data)
        if (parsed === "DONE") return { reader, pending, firstDone: true }
        return { reader, pending, firstChunk: parsed, firstDone: false }
      } catch (error) {
        if (error instanceof UpstreamStreamError) return { reader, pending, firstError: error, firstDone: false }
        throw error
      }
    }

    const next = await reader.read()
    if (next.done) {
      pending += decoder.decode()
      const finalFrame = takeFrame(`${pending}\n\n`)
      if (!finalFrame) return { reader, pending: "", firstDone: true }
      const data = dataFromFrame(finalFrame.frame)
      if (!data) return { reader, pending: "", firstDone: true }
      try {
        const parsed = parseData(data)
        if (parsed === "DONE") return { reader, pending: "", firstDone: true }
        return { reader, pending: "", firstChunk: parsed, firstDone: false }
      } catch (error) {
        if (error instanceof UpstreamStreamError) return { reader, pending: "", firstError: error, firstDone: false }
        throw error
      }
    }
    pending += decoder.decode(next.value, { stream: true })
  }
}

function normalizeUsage(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) return undefined
  const usage: JsonObject = {}
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"]) {
    if (value[key] !== undefined) usage[key] = value[key]
  }
  return usage
}

function reasoningContentFrom(value: JsonObject): unknown {
  return value.reasoning_content !== undefined ? value.reasoning_content : value.reasoning
}

function normalizeDelta(value: unknown): JsonObject {
  if (!isRecord(value)) return {}
  const delta: JsonObject = {}
  for (const key of ["role", "content", "refusal", "tool_calls", "function_call"]) {
    if (value[key] !== undefined) delta[key] = value[key]
  }
  const reasoningContent = reasoningContentFrom(value)
  if (reasoningContent !== undefined) delta.reasoning_content = reasoningContent
  return delta
}

function normalizeChunk(value: JsonObject, model: string, includeUsage: boolean): JsonObject {
  const choices = Array.isArray(value.choices)
    ? value.choices.slice(0, 1).map((choice) => {
        const item = isRecord(choice) ? choice : {}
        return {
          index: typeof item.index === "number" ? item.index : 0,
          delta: normalizeDelta(item.delta),
          finish_reason: item.finish_reason ?? null
        }
      })
    : []
  const normalized: JsonObject = {
    id: typeof value.id === "string" ? value.id : `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : model,
    choices
  }
  if (includeUsage && value.usage !== undefined) {
    normalized.usage = normalizeUsage(value.usage) ?? value.usage
  }
  return normalized
}

function formatSse(value: JsonObject): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
}

function formatSseError(error: unknown): Uint8Array {
  const message = error instanceof Error ? error.message : "The upstream stream failed"
  const code = error instanceof AppError ? error.code : "upstream_stream_error"
  const type = error instanceof AppError ? error.type : "server_error"
  return new TextEncoder().encode(`data: ${JSON.stringify({ error: { message, type, code } })}\n\ndata: [DONE]\n\n`)
}

function processFrame(frame: string, model: string, includeUsage: boolean): { output?: Uint8Array; done: boolean } {
  const data = dataFromFrame(frame)
  if (!data) return { done: false }
  const parsed = parseData(data)
  if (parsed === "DONE") return { done: true }
  if (!includeUsage && parsed.usage !== undefined && (!Array.isArray(parsed.choices) || parsed.choices.length === 0)) {
    return { done: false }
  }
  return { output: formatSse(normalizeChunk(parsed, model, includeUsage)), done: false }
}

export function createSseRelay(prepared: PreparedSse, model: string, includeUsage: boolean): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const decoder = new TextDecoder()
        let pending = prepared.pending
        try {
          if (prepared.firstChunk) {
            const output = processFrame(`data: ${JSON.stringify(prepared.firstChunk)}`, model, includeUsage).output
            if (output) controller.enqueue(output)
          }
          if (!prepared.firstDone) {
            while (true) {
              const frame = takeFrame(pending)
              if (frame) {
                pending = frame.rest
                const processed = processFrame(frame.frame, model, includeUsage)
                if (processed.output) controller.enqueue(processed.output)
                if (processed.done) break
                continue
              }

              const next = await prepared.reader.read()
              if (next.done) {
                pending += decoder.decode()
                const finalFrame = takeFrame(`${pending}\n\n`)
                if (finalFrame) {
                  const processed = processFrame(finalFrame.frame, model, includeUsage)
                  if (processed.output) controller.enqueue(processed.output)
                }
                break
              }
              pending += decoder.decode(next.value, { stream: true })
            }
          }
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        } catch (error) {
          console.error(`[proxy] stream relay failed: ${error instanceof Error ? error.message : "unknown"}`)
          controller.enqueue(formatSseError(error))
        } finally {
          prepared.reader.releaseLock()
          controller.close()
        }
      })()
    }
  })
}

function completionChunkIdentity(value: JsonObject, model: string): JsonObject {
  return {
    id: typeof value.id === "string" ? value.id : `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : model
  }
}

export interface ToolSseRefetch {
  (nudge: string): Promise<PreparedSse>
}

const TOOL_ACTION_MAX_RETRIES = 1

// If the model answered in prose instead of an attempted JSON action, returns
// the trimmed prose so the caller can deliver it as a final message; otherwise
// returns null. "Attempted JSON" (starts with { or [) is a broken action and
// must not be mistaken for a final answer.
function proseCandidate(content: string, error: unknown): string | null {
  const text = content.trim()
  if (!text) return null
  const first = text[0]
  if (first === "{" || first === "[") return null
  const message = error instanceof AppError ? error.message : ""
  return message.includes("was not valid JSON") ? text : null
}

// A corrective nudge tuned to the failure type so the retry has the best
// chance of producing a usable JSON action.
function buildRetryNudge(content: string, error: unknown, choice: "auto" | "required"): string {
  const text = content.trim()
  const message = error instanceof AppError ? error.message : ""
  const finalHint = choice === "auto" ? ', or {"type":"final","content":"..."} to answer directly' : ""

  if (message.includes("content was empty")) {
    return 'Your previous reply was empty. Now emit exactly one JSON object and no prose: {"type":"tool_calls","tool_calls":[{"id":"call_0","name":"<tool>","arguments":{}}]} to call a tool' + finalHint + ". Do not return an empty turn."
  }
  if (message.includes("was not valid JSON") && text && !/^[{[]/.test(text)) {
    return 'Your previous reply was prose, not the required JSON action. Emit ONLY exactly one JSON object and no prose: {"type":"tool_calls","tool_calls":[{"id":"call_0","name":"<tool>","arguments":{}}]} to call a tool' + finalHint + "."
  }
  if (message.includes("was not valid JSON")) {
    // Broken/truncated JSON: surface the parser's reason so the model can fix
    // the exact escaping or truncation problem instead of guessing.
    const reason = message.split("was not valid JSON")[1]?.trim() || ""
    const detail = reason ? ` The parser reported:${reason}` : ""
    return `Your previous reply was not valid JSON and could not be parsed.${detail} Re-emit exactly one valid JSON object with string values properly escaped and no trailing text: {"type":"tool_calls","tool_calls":[{"id":"call_0","name":"<tool>","arguments":{}}]} to call a tool` + finalHint + "."
  }
  if (message.includes("unknown function")) {
    return 'You called a tool that is not in the list. Emit exactly one JSON object using ONLY the listed tool names: {"type":"tool_calls","tool_calls":[{"id":"call_0","name":"<tool>","arguments":{}}]}' + finalHint + "."
  }
  if (message.includes("failed schema validation") || message.includes("arguments")) {
    return 'Your tool arguments were invalid. Emit exactly one JSON object whose arguments satisfy that tool\'s parameters schema' + finalHint + "."
  }
  return 'Your previous response did not provide a usable JSON action. Now emit exactly one JSON object and no prose: {"type":"tool_calls","tool_calls":[{"id":"call_0","name":"<tool>","arguments":{}}]} to call a tool' + finalHint + "."
}

export function createToolSseRelay(
  prepared: PreparedSse,
  model: string,
  includeUsage: boolean,
  plan: ToolPlan,
  refetch?: ToolSseRefetch
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const decoder = new TextDecoder()
        let current = prepared
        let content = ""
        let identity: JsonObject | undefined
        let usage: JsonObject | undefined
        let roleSent = false
        let upstreamFinishReason: unknown = "stop"
        let reasoningChars = 0

        const processToolChunk = (value: JsonObject): void => {
          identity ??= completionChunkIdentity(value, model)
          if (includeUsage && value.usage !== undefined) usage = normalizeUsage(value.usage) ?? (isRecord(value.usage) ? value.usage : undefined)

          const rawChoice = Array.isArray(value.choices) ? value.choices[0] : undefined
          if (!isRecord(rawChoice)) return
          if (rawChoice.finish_reason !== undefined && rawChoice.finish_reason !== null) upstreamFinishReason = rawChoice.finish_reason
          const rawDelta = isRecord(rawChoice.delta) ? rawChoice.delta : {}
          if (typeof rawDelta.content === "string") content += rawDelta.content
          else if (rawDelta.content !== undefined && rawDelta.content !== null) {
            throw new UpstreamStreamError("The upstream returned a non-text tool action delta")
          }

          const delta: JsonObject = {}
          if (typeof rawDelta.role === "string") {
            delta.role = rawDelta.role
            roleSent = true
          }
          const reasoningContent = reasoningContentFrom(rawDelta)
          if (reasoningContent !== undefined) {
            if (typeof reasoningContent === "string") reasoningChars += reasoningContent.length
            delta.reasoning_content = reasoningContent
          }
          if (rawDelta.refusal !== undefined) delta.refusal = rawDelta.refusal
          if (Object.keys(delta).length > 0) {
            controller.enqueue(formatSse({
              ...(identity as JsonObject),
              choices: [{ index: typeof rawChoice.index === "number" ? rawChoice.index : 0, delta, finish_reason: null }]
            }))
          }
        }

        const processToolFrame = (frame: string): boolean => {
          const data = dataFromFrame(frame)
          if (!data) return false
          const parsed = parseData(data)
          if (parsed === "DONE") return true
          processToolChunk(parsed)
          return false
        }

        try {
          let retries = 0
          let action: ParsedToolAction | undefined
          while (true) {
            let pending = current.pending
            if (current.firstChunk) processToolChunk(current.firstChunk)
            let upstreamDone = current.firstDone
            while (!upstreamDone) {
              const frame = takeFrame(pending)
              if (frame) {
                pending = frame.rest
                upstreamDone = processToolFrame(frame.frame)
                continue
              }

              const next = await current.reader.read()
              if (next.done) {
                pending += decoder.decode()
                if (pending) {
                  pending += "\n\n"
                  while (true) {
                    const finalFrame = takeFrame(pending)
                    if (!finalFrame) break
                    pending = finalFrame.rest
                    if (processToolFrame(finalFrame.frame)) {
                      upstreamDone = true
                      break
                    }
                  }
                }
                break
              }
              pending += decoder.decode(next.value, { stream: true })
            }
            current.reader.releaseLock()

            try {
              action = parseToolAction(content, plan)
              break
            } catch (error) {
              const invalidAction = error instanceof AppError && error.code === "invalid_tool_action"
              if (!invalidAction) {
                throw error
              }

              // Auto choice with no useful retry left: the model answered in
              // prose instead of a JSON action. Deliver the prose as the final
              // message instead of failing the whole request.
              if (plan.choice === "auto" && plan.finalResponseFormat === "text") {
                const prose = proseCandidate(content, error)
                if (prose !== null && (!refetch || retries >= TOOL_ACTION_MAX_RETRIES)) {
                  console.warn(`[proxy] tool action fallback: delivering prose as final (auto choice) content_chars=${content.length}`)
                  action = { kind: "final", content: prose }
                  break
                }
              }

              if (!refetch || retries >= TOOL_ACTION_MAX_RETRIES) {
                throw error
              }

              // The reasoning model finished without a usable JSON action
              // (empty content, prose, unknown tool, or bad arguments).
              // Reasoning from this attempt was already streamed; give it one
              // corrective turn so the client still receives a usable result.
              retries += 1
              console.warn(`[proxy] tool action invalid, retry ${retries}/${TOOL_ACTION_MAX_RETRIES}: ${error instanceof Error ? error.message : "unknown"} finish=${String(upstreamFinishReason)} reasoning_chars=${reasoningChars} content_chars=${content.length} content_head=${JSON.stringify(content.slice(0, 160))}`)
              const nudge = buildRetryNudge(content, error, plan.choice)
              content = ""
              identity = undefined
              usage = undefined
              roleSent = false
              upstreamFinishReason = "stop"
              reasoningChars = 0
              current = await refetch(nudge)
            }
          }

          identity ??= completionChunkIdentity({}, model)
          const delta: JsonObject = roleSent ? {} : { role: "assistant" }
          let finishReason: unknown = upstreamFinishReason
          const parsedAction = action as ParsedToolAction
          if (parsedAction.kind === "tool_calls") {
            delta.tool_calls = parsedAction.toolCalls.map((call, index) => ({ index, ...call }))
            finishReason = "tool_calls"
          } else {
            delta.content = parsedAction.content
          }
          console.info(`[proxy] tool action delivered kind=${parsedAction.kind} attempts=${retries + 1} finish=${String(upstreamFinishReason)} reasoning_chars=${reasoningChars} content_chars=${content.length} tools=${plan.tools.length} choice=${plan.choice}`)
          controller.enqueue(formatSse({
            ...identity,
            choices: [{ index: 0, delta, finish_reason: finishReason ?? "stop" }]
          }))

          if (includeUsage && usage) {
            controller.enqueue(formatSse({ ...identity, choices: [], usage }))
          }
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        } catch (error) {
          console.error(`[proxy] tool stream failed: ${error instanceof Error ? error.message : "unknown"} finish=${String(upstreamFinishReason)} reasoning_chars=${reasoningChars} content_chars=${content.length} content_head=${JSON.stringify(content.slice(0, 160))}`)
          controller.enqueue(formatSseError(error))
        } finally {
          controller.close()
        }
      })()
    }
  })
}

export function normalizeCompletion(value: unknown, model: string): JsonObject {
  const record = isRecord(value) ? value : {}
  if (record.error !== undefined) {
    const message = asMessage(record.error)
    throw new AppError(message, 502, "upstream_error")
  }

  const rawChoices = Array.isArray(record.choices) ? record.choices : []
  const choices = rawChoices.slice(0, 1).map((choice) => {
    const item = isRecord(choice) ? choice : {}
    const rawMessage = isRecord(item.message) ? item.message : {}
    const message: JsonObject = { role: typeof rawMessage.role === "string" ? rawMessage.role : "assistant", content: rawMessage.content ?? item.text ?? "" }
    for (const key of ["refusal", "tool_calls", "function_call"]) {
      if (rawMessage[key] !== undefined) message[key] = rawMessage[key]
    }
    const reasoningContent = reasoningContentFrom(rawMessage)
    if (reasoningContent !== undefined) message.reasoning_content = reasoningContent
    return {
      index: typeof item.index === "number" ? item.index : 0,
      message,
      finish_reason: item.finish_reason ?? "stop"
    }
  })

  const normalized: JsonObject = {
    id: typeof record.id === "string" ? record.id : `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: typeof record.created === "number" ? record.created : Math.floor(Date.now() / 1000),
    model: typeof record.model === "string" ? record.model : model,
    choices
  }
  const usage = normalizeUsage(record.usage)
  if (usage) normalized.usage = usage
  return normalized
}

export function normalizeToolCompletion(value: unknown, model: string, plan: ToolPlan): JsonObject {
  const normalized = normalizeCompletion(value, model)
  const choices = Array.isArray(normalized.choices) ? normalized.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const message = choice && isRecord(choice.message) ? choice.message : undefined
  if (!choice || !message) {
    throw new AppError("The upstream returned no completion for the tool request", 502, "invalid_tool_action")
  }

  const action = parseToolAction(message.content, plan)
  if (action.kind === "tool_calls") {
    message.content = null
    message.tool_calls = action.toolCalls
    delete message.function_call
    choice.finish_reason = "tool_calls"
  } else {
    message.content = action.content
  }
  return normalized
}
