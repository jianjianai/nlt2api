import { randomUUID } from "node:crypto"
import { AppError } from "./errors"
import type { AgentLoopResult, AgentModelOutput } from "./agent-loop"

type JsonObject = Record<string, unknown>

export class UpstreamStreamError extends Error {
  readonly isAuthError: boolean

  constructor(message: string, isAuthError = false) {
    super(message)
    this.name = "UpstreamStreamError"
    this.isAuthError = isAuthError
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.message === "string") return value.message
  return "The upstream chat request failed"
}

function completionId(value: JsonObject, model: string, stream: boolean): JsonObject {
  return {
    id: typeof value.id === "string" ? value.id : "chatcmpl-" + randomUUID(),
    object: stream ? "chat.completion.chunk" : "chat.completion",
    created: typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : model
  }
}

function reasoning(value: JsonObject): string {
  const candidate = value.reasoning_content ?? value.reasoning
  return typeof candidate === "string" ? candidate : ""
}

function parseChunk(data: string): JsonObject | "DONE" {
  if (data.trim() === "[DONE]") return "DONE"
  try {
    const parsed: unknown = JSON.parse(data)
    if (!isRecord(parsed)) throw new Error("SSE payload is not an object")
    if (parsed.error !== undefined) throw new UpstreamStreamError(errorMessage(parsed.error), /unauthor|authentication|session|login|cookie|csrf|token/i.test(errorMessage(parsed.error)))
    return parsed
  } catch (error) {
    if (error instanceof UpstreamStreamError) throw error
    throw new UpstreamStreamError("The upstream returned invalid SSE JSON")
  }
}

function nextFrame(buffer: string): { frame: string; rest: string } | undefined {
  const lfIndex = buffer.indexOf("\n\n")
  const crlfIndex = buffer.indexOf("\r\n\r\n")
  if (lfIndex < 0 && crlfIndex < 0) return undefined
  const useCrlf = crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)
  const index = useCrlf ? crlfIndex : lfIndex
  return { frame: buffer.slice(0, index), rest: buffer.slice(index + (useCrlf ? 4 : 2)) }
}

function frameData(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
  return lines.length > 0 ? lines.map((line) => line.slice(5).trimStart()).join("\n") : undefined
}

export async function readJsonCompletion(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new AppError("The upstream returned invalid JSON", 502, "invalid_upstream_json")
  }
}

export function completionToModelOutput(value: unknown, model: string): AgentModelOutput {
  if (!isRecord(value)) throw new AppError("The upstream returned an invalid completion", 502, "invalid_upstream_completion")
  if (value.error !== undefined) throw new AppError(errorMessage(value.error), 502, "upstream_error")
  const choice = Array.isArray(value.choices) && isRecord(value.choices[0]) ? value.choices[0] : undefined
  const message = choice && isRecord(choice.message) ? choice.message : undefined
  if (!choice || !message) throw new AppError("The upstream returned no completion choice", 502, "invalid_upstream_completion")
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")
  return {
    content,
    ...(reasoning(message) ? { reasoning: reasoning(message) } : {}),
    ...(isRecord(value.usage) ? { usage: value.usage } : {}),
    finishReason: choice.finish_reason
  }
}

export async function readSseCompletion(body: ReadableStream<Uint8Array> | null): Promise<AgentModelOutput> {
  if (!body) throw new AppError("The upstream returned an empty streaming body", 502, "empty_upstream_body")
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let content = ""
  let reasoningText = ""
  let usage: JsonObject | undefined
  let finishReason: unknown
  try {
    while (true) {
      const frame = nextFrame(pending)
      if (frame) {
        pending = frame.rest
        const data = frameData(frame.frame)
        if (!data) continue
        const parsed = parseChunk(data)
        if (parsed === "DONE") break
        if (isRecord(parsed.usage)) usage = parsed.usage
        const choice = Array.isArray(parsed.choices) && isRecord(parsed.choices[0]) ? parsed.choices[0] : undefined
        const delta = choice && isRecord(choice.delta) ? choice.delta : undefined
        if (delta) {
          if (typeof delta.content === "string") content += delta.content
          reasoningText += reasoning(delta)
        }
        if (choice && choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason
        continue
      }
      const next = await reader.read()
      if (next.done) {
        pending += decoder.decode()
        if (pending) {
          const data = frameData(pending)
          if (data) {
            const parsed = parseChunk(data)
            if (parsed !== "DONE" && Array.isArray(parsed.choices) && isRecord(parsed.choices[0])) {
              const delta = isRecord(parsed.choices[0].delta) ? parsed.choices[0].delta : {}
              if (typeof delta.content === "string") content += delta.content
              reasoningText += reasoning(delta)
              finishReason = parsed.choices[0].finish_reason ?? finishReason
            }
          }
        }
        break
      }
      pending += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  if (!content && !reasoningText && finishReason === undefined && !usage) throw new AppError("The upstream returned an empty completion", 502, "empty_upstream_completion")
  return { content, ...(reasoningText ? { reasoning: reasoningText } : {}), ...(usage ? { usage } : {}), finishReason }
}

export function completionFromAgentResult(result: AgentLoopResult, model: string): JsonObject {
  const message: JsonObject = { role: "assistant", content: result.content }
  if (result.reasoning) message.reasoning_content = result.reasoning
  const finishReason = result.kind === "tool_calls" ? "tool_calls" : "stop"
  if (result.kind === "tool_calls") message.tool_calls = result.toolCalls
  return {
    ...completionId({}, model, false),
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(result.usage ? { usage: result.usage } : {})
  }
}

function sse(value: JsonObject): Uint8Array {
  return new TextEncoder().encode("data: " + JSON.stringify(value) + "\n\n")
}

export function createOpenAIStream(result: AgentLoopResult, model: string, includeUsage: boolean): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const identity = completionId({}, model, true)
      const delta: JsonObject = { role: "assistant" }
      if (result.reasoning) delta.reasoning_content = result.reasoning
      if (result.kind === "final" && result.content) delta.content = result.content
      controller.enqueue(sse({ ...identity, choices: [{ index: 0, delta, finish_reason: null }] }))
      const finalDelta: JsonObject = result.kind === "tool_calls" ? { tool_calls: result.toolCalls } : {}
      controller.enqueue(sse({ ...identity, choices: [{ index: 0, delta: finalDelta, finish_reason: result.kind === "tool_calls" ? "tool_calls" : "stop" }] }))
      if (includeUsage && result.usage) controller.enqueue(sse({ ...identity, choices: [], usage: result.usage }))
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
      controller.close()
    }
  })
}
