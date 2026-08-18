import { randomUUID } from "node:crypto"
import type { AgentProtocolResult } from "../agent/protocol"
import { ApiError, asApiError, openAIErrorBody } from "../shared/errors"
import { cloneJson, isJsonObject, type JsonObject } from "../shared/json"
import { parseSseJson, SseDecoder } from "../portal/sse"

interface CompletionIdentity {
  id: string
  created: number
  model: string
}

export interface AgentStreamOptions {
  model: string
  includeUsage: boolean
  signal?: AbortSignal
  run(options: { signal: AbortSignal; onProgress(content: string): void }): Promise<AgentProtocolResult>
}

function identity(value: JsonObject, model: string): CompletionIdentity {
  return {
    id: typeof value.id === "string" && value.id ? value.id : `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    created: typeof value.created === "number" && Number.isFinite(value.created)
      ? Math.floor(value.created)
      : Math.floor(Date.now() / 1_000),
    model: typeof value.model === "string" && value.model ? value.model : model
  }
}

function reasoning(value: JsonObject): string | undefined {
  const candidate = value.reasoning_content ?? value.reasoning
  return typeof candidate === "string" && candidate ? candidate : undefined
}

function normalizedUsage(value: unknown): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined
  const usage: JsonObject = {}
  for (const key of [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_tokens_details",
    "completion_tokens_details"
  ]) {
    if (value[key] !== undefined) usage[key] = cloneJson(value[key])
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

function firstChoice(value: JsonObject): JsonObject {
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined
  if (!isJsonObject(choice)) {
    throw new ApiError("The NeuralWatt portal returned no completion choice", {
      status: 502,
      code: "invalid_upstream_completion"
    })
  }
  return choice
}

function embeddedError(value: JsonObject): string | undefined {
  if (typeof value.error === "string" && value.error.trim()) return value.error.trim()
  if (isJsonObject(value.error) && typeof value.error.message === "string" && value.error.message.trim()) {
    return value.error.message.trim()
  }
  return undefined
}

export function portalCompletionToAgentOutput(value: JsonObject): {
  content: string
  reasoning?: string
  usage?: JsonObject
  finishReason?: unknown
} {
  const error = embeddedError(value)
  if (error) throw new ApiError(error, { status: 502, code: "upstream_error" })
  const choice = firstChoice(value)
  if (!isJsonObject(choice.message)) {
    throw new ApiError("The NeuralWatt portal returned an invalid completion message", {
      status: 502,
      code: "invalid_upstream_completion"
    })
  }
  const content = choice.message.content
  if (typeof content !== "string" && content !== null) {
    throw new ApiError("The NeuralWatt portal returned invalid completion content", {
      status: 502,
      code: "invalid_upstream_completion"
    })
  }
  const reasoningContent = reasoning(choice.message)
  const usage = normalizedUsage(value.usage)
  return {
    content: content ?? "",
    ...(reasoningContent ? { reasoning: reasoningContent } : {}),
    ...(usage ? { usage } : {}),
    ...(choice.finish_reason !== undefined ? { finishReason: choice.finish_reason } : {})
  }
}

export function normalizePortalCompletion(value: JsonObject, requestedModel: string): JsonObject {
  const error = embeddedError(value)
  if (error) throw new ApiError(error, { status: 502, code: "upstream_error" })
  const choice = firstChoice(value)
  if (!isJsonObject(choice.message)) {
    throw new ApiError("The NeuralWatt portal returned an invalid completion message", {
      status: 502,
      code: "invalid_upstream_completion"
    })
  }
  const sourceMessage = choice.message
  const content = sourceMessage.content
  if (typeof content !== "string" && content !== null) {
    throw new ApiError("The NeuralWatt portal returned invalid completion content", {
      status: 502,
      code: "invalid_upstream_completion"
    })
  }
  const message: JsonObject = { role: "assistant", content }
  const reasoningContent = reasoning(sourceMessage)
  if (reasoningContent) message.reasoning_content = reasoningContent
  const completionIdentity = identity(value, requestedModel)
  const usage = normalizedUsage(value.usage)
  return {
    ...completionIdentity,
    object: "chat.completion",
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : null
    }],
    ...(usage ? { usage } : {})
  }
}

export function completionFromAgent(result: AgentProtocolResult, model: string): JsonObject {
  const message: JsonObject = { role: "assistant", content: result.content }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.kind === "tool_calls") message.tool_calls = cloneJson(result.toolCalls)
  return {
    ...identity({}, model),
    object: "chat.completion",
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: result.kind === "tool_calls" ? "tool_calls" : "stop"
    }],
    ...(result.usage ? { usage: normalizedUsage(result.usage) ?? cloneJson(result.usage) } : {})
  }
}

function encodeSse(value: JsonObject | "[DONE]"): Uint8Array {
  const text = value === "[DONE]" ? "[DONE]" : JSON.stringify(value)
  return new TextEncoder().encode(`data: ${text}\n\n`)
}

function streamChunk(identityValue: CompletionIdentity, delta: JsonObject, finishReason: string | null, includeUsage: boolean): JsonObject {
  return {
    ...identityValue,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    ...(includeUsage ? { usage: null } : {})
  }
}

function standardStreamError(error: unknown): JsonObject {
  return openAIErrorBody(asApiError(error))
}

export function normalizePortalStream(
  body: ReadableStream<Uint8Array> | null,
  requestedModel: string,
  includeUsage: boolean
): ReadableStream<Uint8Array> {
  if (!body) {
    throw new ApiError("The NeuralWatt portal returned an empty stream", {
      status: 502,
      code: "empty_upstream_stream"
    })
  }
  const decoder = new TextDecoder()
  const parser = new SseDecoder()
  const reader = body.getReader()
  let completionIdentity: CompletionIdentity | undefined
  let finalUsage: JsonObject | undefined
  const pending: Uint8Array[] = []
  let terminal = false
  let released = false

  function releaseReader(): void {
    if (released) return
    released = true
    try {
      reader.releaseLock()
    } catch {
      // A canceled reader may already have released its lock.
    }
  }

  async function cancelReader(reason: unknown): Promise<void> {
    if (released) return
    try {
      await reader.cancel(reason)
    } catch {
      // The client-facing terminal frame has already been queued.
    } finally {
      releaseReader()
    }
  }

  function queueParsedEvent(parsed: JsonObject | "[DONE]"): void {
    if (terminal) return
    if (parsed === "[DONE]") {
      if (includeUsage && finalUsage) {
        const id = completionIdentity ?? identity({}, requestedModel)
        pending.push(encodeSse({ ...id, object: "chat.completion.chunk", choices: [], usage: finalUsage }))
      }
      pending.push(encodeSse("[DONE]"))
      terminal = true
      return
    }
    const error = embeddedError(parsed)
    if (error) {
      pending.push(encodeSse(standardStreamError(new ApiError(error, { status: 502, code: "upstream_stream_error" }))))
      terminal = true
      return
    }
    completionIdentity ??= identity(parsed, requestedModel)
    const usage = normalizedUsage(parsed.usage)
    if (usage) finalUsage = usage
    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    for (const rawChoice of choices) {
      if (!isJsonObject(rawChoice)) continue
      const sourceDelta = isJsonObject(rawChoice.delta) ? rawChoice.delta : {}
      const delta: JsonObject = {}
      if (sourceDelta.role === "assistant") delta.role = "assistant"
      if (typeof sourceDelta.content === "string") delta.content = sourceDelta.content
      const reasoningContent = reasoning(sourceDelta)
      if (reasoningContent) delta.reasoning_content = reasoningContent
      const finishReason = typeof rawChoice.finish_reason === "string" ? rawChoice.finish_reason : null
      if (Object.keys(delta).length > 0 || finishReason !== null) {
        pending.push(encodeSse(streamChunk(completionIdentity, delta, finishReason, includeUsage)))
      }
    }
  }

  function queueEvents(events: ReturnType<SseDecoder["push"]>): void {
    try {
      for (const event of events) {
        queueParsedEvent(parseSseJson(event.data))
        if (terminal) return
      }
    } catch (error) {
      pending.push(encodeSse(standardStreamError(error)))
      terminal = true
    }
  }

  function finishInput(): void {
    try {
      const trailing = parser.push(decoder.decode())
      trailing.push(...parser.finish())
      queueEvents(trailing)
    } catch (error) {
      pending.push(encodeSse(standardStreamError(error)))
      terminal = true
    }
    if (!terminal) {
      pending.push(encodeSse(standardStreamError(new ApiError(
        "The NeuralWatt portal stream ended before data: [DONE]",
        { status: 502, code: "truncated_upstream_stream" }
      ))))
      terminal = true
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (pending.length === 0 && !terminal) {
        try {
          const next = await reader.read()
          if (next.done) {
            releaseReader()
            finishInput()
          } else {
            queueEvents(parser.push(decoder.decode(next.value, { stream: true })))
            if (terminal) void cancelReader("upstream_stream_terminal_event")
          }
        } catch (error) {
          releaseReader()
          const streamError = error instanceof ApiError ? error : new ApiError(
            "The NeuralWatt portal stream failed after it started",
            { status: 502, code: "upstream_stream_error", cause: error }
          )
          pending.push(encodeSse(standardStreamError(streamError)))
          terminal = true
        }
      }

      const chunk = pending.shift()
      if (chunk) controller.enqueue(chunk)
      if (terminal && pending.length === 0) controller.close()
    },
    async cancel(reason) {
      terminal = true
      pending.length = 0
      await cancelReader(reason)
    }
  })
}

export function createAgentStream(options: AgentStreamOptions): ReadableStream<Uint8Array> {
  const abort = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal
  const streamIdentity = identity({}, options.model)
  let settled = false
  let removeExternalAbort = (): void => {}

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (settled) return
        settled = true
        removeExternalAbort()
        controller.close()
      }
      if (options.signal) {
        const onExternalAbort = (): void => close()
        options.signal.addEventListener("abort", onExternalAbort, { once: true })
        removeExternalAbort = () => options.signal?.removeEventListener("abort", onExternalAbort)
        if (options.signal.aborted) {
          close()
          return
        }
      }
      controller.enqueue(encodeSse(streamChunk(streamIdentity, { role: "assistant" }, null, options.includeUsage)))
      void options.run({
        signal,
        onProgress(content) {
          if (!settled && !signal.aborted && content) {
            controller.enqueue(encodeSse(streamChunk(streamIdentity, { content }, null, options.includeUsage)))
          }
        }
      }).then((result) => {
        if (signal.aborted) {
          close()
          return
        }
        const delta: JsonObject = {}
        if (result.reasoning) delta.reasoning_content = result.reasoning
        if (result.kind === "final") {
          if (result.content) delta.content = result.content
        } else {
          delta.tool_calls = result.toolCalls.map((call, index) => ({ index, ...cloneJson(call) }))
        }
        if (Object.keys(delta).length > 0) {
          controller.enqueue(encodeSse(streamChunk(streamIdentity, delta, null, options.includeUsage)))
        }
        controller.enqueue(encodeSse(streamChunk(
          streamIdentity,
          {},
          result.kind === "tool_calls" ? "tool_calls" : "stop",
          options.includeUsage
        )))
        const usage = result.usage ? normalizedUsage(result.usage) ?? cloneJson(result.usage) : undefined
        if (options.includeUsage && usage) {
          controller.enqueue(encodeSse({ ...streamIdentity, object: "chat.completion.chunk", choices: [], usage }))
        }
        controller.enqueue(encodeSse("[DONE]"))
        close()
      }).catch((error: unknown) => {
        if (signal.aborted) {
          close()
          return
        }
        controller.enqueue(encodeSse(standardStreamError(error)))
        close()
      })
    },
    cancel(reason) {
      settled = true
      removeExternalAbort()
      abort.abort(reason)
    }
  })
}
