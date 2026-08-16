import { randomUUID } from "node:crypto"
import { AppError } from "./errors"

type JsonObject = Record<string, unknown>

export class UpstreamStreamError extends Error {
  readonly isAuthError: boolean

  constructor(message: string, isAuthError = false) {
    super(message)
    this.name = "UpstreamStreamError"
    this.isAuthError = isAuthError
  }
}

interface PreparedSse {
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
  return new TextEncoder().encode(`data: ${JSON.stringify({ error: { message, type: "server_error", code: "upstream_stream_error" } })}\n\ndata: [DONE]\n\n`)
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
          controller.enqueue(formatSseError(error))
        } finally {
          prepared.reader.releaseLock()
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
