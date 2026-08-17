import { randomUUID } from "node:crypto"
import { AppError } from "./errors"
import { TOOL_PROSE_FINAL_PREFIX, ToolActionError, ToolActionXmlStream, parseToolAction, type ParsedToolAction, type ToolPlan } from "./tools"

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
  firstDoneSentinel?: boolean
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
        if (parsed === "DONE") return { reader, pending, firstDone: true, firstDoneSentinel: true }
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
        if (parsed === "DONE") return { reader, pending: "", firstDone: true, firstDoneSentinel: true }
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

function mergeUsage(total: JsonObject | undefined, next: JsonObject | undefined): JsonObject | undefined {
  if (!next) return total
  if (!total) return { ...next }

  const merged: JsonObject = { ...total }
  for (const [key, value] of Object.entries(next)) {
    const current = merged[key]
    if (typeof current === "number" && typeof value === "number") {
      merged[key] = current + value
    } else if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeUsage(current, value) ?? value
    } else {
      merged[key] = value
    }
  }
  return merged
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

function createDirectSseRelay(prepared: PreparedSse, model: string, includeUsage: boolean): ReadableStream<Uint8Array> {
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

export interface OutputLengthContinuation {
  reasoning: string
  content: string
  nudge: string
}

export interface SseLengthRefetch {
  (continuation: OutputLengthContinuation): Promise<PreparedSse>
}

export interface CompletionLengthRefetch {
  (continuation: OutputLengthContinuation): Promise<unknown>
}

const OUTPUT_LENGTH_CONTINUATION_MAX_RETRIES = 10
const OUTPUT_LENGTH_CONTINUATION_REASONING_MAX_CHARS = 32_000
const OUTPUT_LENGTH_CONTINUATION_CONTENT_MAX_CHARS = 32_000

function buildOutputLengthContinuation(reasoning: string, content: string): OutputLengthContinuation {
  return {
    reasoning: tailForRetry(reasoning, OUTPUT_LENGTH_CONTINUATION_REASONING_MAX_CHARS),
    content: tailForRetry(content, OUTPUT_LENGTH_CONTINUATION_CONTENT_MAX_CHARS),
    nudge: "Your previous response reached the output token limit. Continue from the preceding assistant reasoning and response without repeating it. Complete the answer with minimal additional reasoning."
  }
}

function createSseLengthContinuationRelay(
  prepared: PreparedSse,
  model: string,
  includeUsage: boolean,
  refetch: SseLengthRefetch
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const decoder = new TextDecoder()
        let current = prepared
        let currentReaderReleased = false
        let identity: JsonObject | undefined
        let roleSent = false
        let totalUsage: JsonObject | undefined
        let retries = 0

        try {
          while (true) {
            let pending = current.pending
            let attemptReasoning = ""
            let attemptContent = ""
            let attemptUsage: JsonObject | undefined
            let finishReason: unknown
            let finishIndex = 0

            const processChunk = (value: JsonObject): void => {
              identity ??= completionChunkIdentity(value, model)
              if (includeUsage && value.usage !== undefined) {
                attemptUsage = normalizeUsage(value.usage) ?? (isRecord(value.usage) ? value.usage : undefined)
              }

              const rawChoice = Array.isArray(value.choices) ? value.choices[0] : undefined
              if (!isRecord(rawChoice)) return
              const rawDelta = isRecord(rawChoice.delta) ? rawChoice.delta : {}
              if (typeof rawDelta.content === "string") attemptContent += rawDelta.content
              const reasoningContent = reasoningContentFrom(rawDelta)
              if (typeof reasoningContent === "string") attemptReasoning += reasoningContent

              const rawFinishReason = rawChoice.finish_reason
              if (rawFinishReason !== undefined && rawFinishReason !== null) {
                finishReason = rawFinishReason
                finishIndex = typeof rawChoice.index === "number" ? rawChoice.index : 0
              }

              const delta = normalizeDelta(rawDelta)
              if (typeof delta.role === "string") {
                if (roleSent) delete delta.role
                else roleSent = true
              }
              if (Object.keys(delta).length === 0 && isLengthTruncation(rawFinishReason)) return

              controller.enqueue(formatSse({
                ...(identity as JsonObject),
                choices: [{
                  index: typeof rawChoice.index === "number" ? rawChoice.index : 0,
                  delta,
                  finish_reason: isLengthTruncation(rawFinishReason) ? null : rawFinishReason ?? null
                }]
              }))
            }

            const processFrame = (frame: string): boolean => {
              const data = dataFromFrame(frame)
              if (!data) return false
              const parsed = parseData(data)
              if (parsed === "DONE") return true
              processChunk(parsed)
              return false
            }

            if (current.firstChunk) processChunk(current.firstChunk)
            let upstreamDone = current.firstDone
            while (!upstreamDone) {
              const frame = takeFrame(pending)
              if (frame) {
                pending = frame.rest
                upstreamDone = processFrame(frame.frame)
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
                    if (processFrame(finalFrame.frame)) {
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
            currentReaderReleased = true
            totalUsage = mergeUsage(totalUsage, attemptUsage)
            if (isLengthTruncation(finishReason) && retries < OUTPUT_LENGTH_CONTINUATION_MAX_RETRIES) {
              const continuation = buildOutputLengthContinuation(attemptReasoning, attemptContent)
              retries += 1
              console.warn(`[proxy] output continuation attempt=${retries}/${OUTPUT_LENGTH_CONTINUATION_MAX_RETRIES} reasoning_chars=${continuation.reasoning.length} content_chars=${continuation.content.length}`)
              controller.enqueue(formatSse({
                ...(identity ?? completionChunkIdentity({}, model)),
                choices: [{
                  index: finishIndex,
                  delta: {
                    reasoning_content: encodeErrorBlock(continuation, {
                      reasoningChars: attemptReasoning.length,
                      contentChars: attemptContent.length
                    })
                  },
                  finish_reason: null
                }]
              }))
              current = await refetch(continuation)
              currentReaderReleased = false
              continue
            }

            identity ??= completionChunkIdentity({}, model)
            if (isLengthTruncation(finishReason)) {
              controller.enqueue(formatSse({
                ...identity,
                choices: [{ index: finishIndex, delta: {}, finish_reason: finishReason }]
              }))
            }
            if (includeUsage && totalUsage) {
              controller.enqueue(formatSse({ ...identity, choices: [], usage: totalUsage }))
            }
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            break
          }
        } catch (error) {
          console.error(`[proxy] stream continuation failed: ${error instanceof Error ? error.message : "unknown"}`)
          controller.enqueue(formatSseError(error))
        } finally {
          if (!currentReaderReleased) current.reader.releaseLock()
          controller.close()
        }
      })()
    }
  })
}

export function createSseRelay(
  prepared: PreparedSse,
  model: string,
  includeUsage: boolean,
  refetch?: SseLengthRefetch
): ReadableStream<Uint8Array> {
  return refetch
    ? createSseLengthContinuationRelay(prepared, model, includeUsage, refetch)
    : createDirectSseRelay(prepared, model, includeUsage)
}

function completionChunkIdentity(value: JsonObject, model: string): JsonObject {
  return {
    id: typeof value.id === "string" ? value.id : `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : model
  }
}

export type ToolActionRetryCause = "invalid_action" | "length" | "timeout"
export type ToolActionRetryContext = "extend" | "isolated"

export interface ToolActionRetry {
  cause: ToolActionRetryCause
  attempt: number
  context: ToolActionRetryContext
  retryAfterMs: number
  reasoning: string
  content: string
  nudge: string
}

export interface ToolSseRefetch {
  (failed: ToolActionRetry): Promise<PreparedSse>
}

export interface ToolCompletionRefetch {
  (failed: ToolActionRetry): Promise<unknown>
}

const TOOL_LENGTH_CONTINUATION_MAX_RETRIES = 10
const TOOL_MODEL_CORRECTION_MAX_RETRIES = 5
const TOOL_LENGTH_CONTINUATION_REASONING_MAX_CHARS = 32_000
const TOOL_LENGTH_CONTINUATION_CONTENT_MAX_CHARS = 8_000
const TOOL_INVALID_ACTION_REASONING_MAX_CHARS = 2_000
const TOOL_INVALID_ACTION_CONTENT_MAX_CHARS = 1_500

function allowsMarkedProse(plan: ToolPlan): boolean {
  return plan.choice === "auto" && plan.finalResponseFormat === "text"
}

function markedProseFinal(content: unknown, plan: ToolPlan): string | null {
  if (!allowsMarkedProse(plan) || typeof content !== "string" || !content.startsWith(TOOL_PROSE_FINAL_PREFIX)) {
    return null
  }
  const prose = content.slice(TOOL_PROSE_FINAL_PREFIX.length)
  return prose.trim() ? prose : null
}

function looksLikeXmlAction(content: string): boolean {
  return /^\s*(?:```xml\s*)?<(?:tool_calls|final)\b/i.test(content)
}

// Identifies bare prose so retries can explain how to attach it to a tool action.
function proseCandidate(content: string, error: unknown): string | null {
  const text = content.trim()
  if (!text || !(error instanceof ToolActionError)) return null
  if (
    error.failure.kind !== "invalid_xml" &&
    error.failure.kind !== "invalid_xml_root" &&
    error.failure.kind !== "invalid_xml_structure"
  ) return null
  return looksLikeXmlAction(text) ? null : text
}

// Failed attempts remain observable to clients. Isolated recoveries reset prior
// retry replay so malformed output cannot become a later model prompt.
type ErrorBlockAttempt = Pick<OutputLengthContinuation, "reasoning" | "content" | "nudge">
  & Partial<Pick<ToolActionRetry, "context">>

function encodeErrorBlock(
  attempt: ErrorBlockAttempt,
  visible?: { reasoningChars: number; contentChars: number }
): string {
  const replayFailedAttempt = attempt.context !== "isolated"
  const hasAssistantTurn = replayFailedAttempt && Boolean(attempt.reasoning || attempt.content)
  return `[NWERR-START]${JSON.stringify({
    v: visible ? 2 : 1,
    assistant: hasAssistantTurn,
    ...(replayFailedAttempt ? {} : { replay: "omit" }),
    reasoning: attempt.reasoning,
    out: attempt.content,
    reason: attempt.nudge,
    ...(visible ? {
      visible_reasoning_chars: visible.reasoningChars,
      visible_content_chars: visible.contentChars
    } : {})
  })}[NWERR-END]`
}

function retryActionContract(plan: ToolPlan): string {
  const final = allowsMarkedProse(plan)
    ? ` If no tool is needed, emit ${TOOL_PROSE_FINAL_PREFIX}<completed answer>.`
    : plan.choice === "auto"
      ? " If no tool is needed, emit <final><![CDATA[completed answer]]></final>."
      : " A final answer is not allowed in this request."
  return `Return only one corrected XML action using the system protocol. Do not emit a plan, prose, Markdown fence, or <id>.${final}`
}

function buildUnmarkedProseRetryNudge(plan: ToolPlan): string {
  return `The previous reply was unmarked prose; the proxy did not run a tool. Put only a short user-facing sentence in <progress>, include the actual <tool_call>, and return the complete XML action. ${retryActionContract(plan)}`
}

function isLengthTruncation(finishReason: unknown): boolean {
  return finishReason === "length"
}

function isUpstreamTimeout(error: unknown): boolean {
  if (error instanceof AppError && error.code === "upstream_timeout") return true
  if (!(error instanceof Error)) return false
  return error.name === "TimeoutError" || /aborted due to timeout|timed out|timeout/i.test(error.message)
}

function buildTimeoutRetry(
  reasoning: string,
  content: string,
  plan: ToolPlan,
  isolatedRecoveryActive: boolean
): ToolActionRetry {
  return {
    cause: "timeout",
    attempt: 1,
    context: isolatedRecoveryActive ? "isolated" : "extend",
    retryAfterMs: 0,
    reasoning: tailForRetry(reasoning, TOOL_INVALID_ACTION_REASONING_MAX_CHARS),
    content: tailForRetry(content, TOOL_INVALID_ACTION_CONTENT_MAX_CHARS),
    nudge: isolatedRecoveryActive
      ? strictFormatRecoveryNudge(plan)
      : `The upstream response timed out before a complete action. Continue once and return only the XML action from the system protocol. Do not repeat prior reasoning. ${plan.choice === "required" ? "A tool call is required." : "Use <final> only when no tool is needed."}`
  }
}

function tailForRetry(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(-maximum) : value
}

function buildLengthContinuationNudge(plan: ToolPlan): string {
  return `Your previous tool-protocol turn reached the output token limit before it produced a complete action. Continue from the preceding assistant reasoning and partial output. Do not restart, repeat, or explain the analysis. Use minimal additional reasoning and immediately ${retryActionContract(plan)}`
}

function isXmlFormatFailure(error: unknown, content: string): boolean {
  if (!(error instanceof ToolActionError) || !looksLikeXmlAction(content.trim())) return false
  return error.failure.kind === "invalid_xml"
    || error.failure.kind === "invalid_xml_root"
    || error.failure.kind === "invalid_xml_structure"
}

function isEmptyUpstreamAction(error: unknown, content: string): boolean {
  return error instanceof ToolActionError
    && error.failure.kind === "empty_content"
    && !content.trim()
}

function emptyActionRetryDelay(attempt: number): number {
  return Math.min(4_000, 500 * 2 ** (attempt - 1))
}

function strictFormatRecoveryNudge(plan: ToolPlan): string {
  const action = plan.choice === "required"
    ? "Emit exactly one complete <tool_calls> document containing at least one <tool_call>."
    : allowsMarkedProse(plan)
      ? `Emit exactly one complete <tool_calls> document, or ${TOOL_PROSE_FINAL_PREFIX}<completed answer> only when no tool is needed.`
      : "Emit exactly one complete XML document rooted at <tool_calls> or <final>."
  return `Format recovery: discard the preceding malformed output. ${action} Start directly with the action. For XML, close every element and use only allowed function names with schema-valid arguments. Do not emit progress, reasoning, error reports, NWERR text, Markdown, or any other prose.`
}

function emptyActionRecoveryNudge(plan: ToolPlan, attempt: number): string {
  const status = attempt === 1
    ? "The upstream completed without any action content."
    : "The upstream again completed without any action content."
  return `${status} Regenerate a fresh action for the original user request. ${strictFormatRecoveryNudge(plan)}`
}

function buildToolActionRetry(
  error: unknown,
  plan: ToolPlan,
  finishReason: unknown,
  reasoning: string,
  content: string,
  retryAttempt: number,
  consecutiveFormatFailures: number,
  isolatedRecoveryActive: boolean
): ToolActionRetry {
  const cause: ToolActionRetryCause = isLengthTruncation(finishReason) ? "length" : "invalid_action"
  const reasoningLimit = cause === "length" ? TOOL_LENGTH_CONTINUATION_REASONING_MAX_CHARS : TOOL_INVALID_ACTION_REASONING_MAX_CHARS
  const contentLimit = cause === "length" ? TOOL_LENGTH_CONTINUATION_CONTENT_MAX_CHARS : TOOL_INVALID_ACTION_CONTENT_MAX_CHARS
  const emptyUpstreamAction = cause === "invalid_action" && isEmptyUpstreamAction(error, content)
  const strictFormatRecovery = cause === "invalid_action" && consecutiveFormatFailures >= 2
  const isolated = isolatedRecoveryActive || emptyUpstreamAction || strictFormatRecovery
  return {
    cause,
    attempt: retryAttempt,
    context: isolated ? "isolated" : "extend",
    retryAfterMs: emptyUpstreamAction ? emptyActionRetryDelay(retryAttempt) : 0,
    reasoning: tailForRetry(reasoning, reasoningLimit),
    content: tailForRetry(content, contentLimit),
    nudge: emptyUpstreamAction
      ? emptyActionRecoveryNudge(plan, retryAttempt)
      : isolated
        ? strictFormatRecoveryNudge(plan)
        : cause === "length"
          ? buildLengthContinuationNudge(plan)
          : buildRetryNudge(content, error, plan)
  }
}

function terminalToolActionError(error: unknown, finishReason: unknown): unknown {
  if (!isLengthTruncation(finishReason)) return error
  return new AppError("The upstream reached the output token limit before producing a complete tool action", 502, "tool_action_length_exceeded")
}

// A compact model-facing correction derived from the parser's structured
// failure rather than matching human-readable error text.
function buildRetryNudge(content: string, error: unknown, plan: ToolPlan): string {
  const failure = error instanceof ToolActionError ? error.failure : undefined
  const contract = retryActionContract(plan)
  if (!failure) return `Your previous reply did not provide a usable action. ${contract}`
  if (proseCandidate(content, error) !== null) return buildUnmarkedProseRetryNudge(plan)

  switch (failure.kind) {
    case "empty_content":
      return `Your previous reply was empty. ${contract}`
    case "invalid_xml":
      return `XML parse failed${failure.detail ? ` (${failure.detail})` : ""}. ${contract}`
    case "invalid_xml_root":
      return `Use one <tool_calls> or <final> root; the previous root was <${failure.name}>. ${contract}`
    case "invalid_xml_structure":
      return `XML structure failed: ${failure.detail}. ${contract}`
    case "empty_tool_calls":
      return `<tool_calls> needs at least one <tool_call>. ${contract}`
    case "parallel_calls_not_allowed":
      return `Only one <tool_call> is allowed in this turn. ${contract}`
    case "missing_function_name":
      return `<tool_call> ${failure.index + 1} needs a <name>. ${contract}`
    case "unknown_function":
      return `Unknown function ${failure.name}. Use only a name from TOOL DEFINITIONS. ${contract}`
    case "schema_validation":
      return `Arguments for ${failure.name} failed schema validation: ${failure.details}. ${contract}`
    case "final_when_tool_required":
      return `tool_choice=required requires one or more tool calls in this response. ${contract}`
    case "final_content_not_json_object":
      return `<final> must contain one <object>. ${contract}`
    case "final_content_not_string":
      return `<final> must contain text or one <string>. ${contract}`
  }
  return `Your previous reply did not provide a usable action. ${contract}`
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
        let totalUsage: JsonObject | undefined
        let roleSent = false
        let upstreamFinishReason: unknown = "stop"
        let reasoningText = ""
        let markedProse = false
        let markedProseContent = ""
        let xmlStream: ToolActionXmlStream | undefined
        let sawDoneSentinel = false

        const processToolChunk = (value: JsonObject): void => {
          identity ??= completionChunkIdentity(value, model)
          if (includeUsage && value.usage !== undefined) usage = normalizeUsage(value.usage) ?? (isRecord(value.usage) ? value.usage : undefined)

          const rawChoice = Array.isArray(value.choices) ? value.choices[0] : undefined
          if (!isRecord(rawChoice)) return
          if (rawChoice.finish_reason !== undefined && rawChoice.finish_reason !== null) upstreamFinishReason = rawChoice.finish_reason
          const rawDelta = isRecord(rawChoice.delta) ? rawChoice.delta : {}
          let visibleContent: string | undefined
          if (typeof rawDelta.content === "string") {
            const chunk = rawDelta.content
            content += chunk
            if (markedProse) {
              markedProseContent += chunk
              visibleContent = chunk
            } else {
              const prose = markedProseFinal(content, plan)
              if (prose !== null) {
                markedProse = true
                markedProseContent = prose
                visibleContent = prose
                xmlStream = undefined
              } else if (!(allowsMarkedProse(plan) && content === TOOL_PROSE_FINAL_PREFIX)) {
                if (xmlStream) xmlStream.write(chunk)
                else {
                  xmlStream = new ToolActionXmlStream(plan)
                  xmlStream.write(content)
                }
              }
            }
          } else if (rawDelta.content !== undefined && rawDelta.content !== null) {
            throw new UpstreamStreamError("The upstream returned a non-text tool action delta")
          }

          const delta: JsonObject = {}
          if (typeof rawDelta.role === "string" && !roleSent) {
            delta.role = rawDelta.role
            roleSent = true
          }
          const reasoningContent = reasoningContentFrom(rawDelta)
          if (reasoningContent !== undefined) {
            if (typeof reasoningContent === "string") reasoningText += reasoningContent
            delta.reasoning_content = reasoningContent
          }
          if (visibleContent !== undefined && visibleContent.length > 0) {
            if (!roleSent && delta.role === undefined) {
              delta.role = "assistant"
              roleSent = true
            }
            delta.content = visibleContent
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
          if (parsed === "DONE") {
            sawDoneSentinel = true
            return true
          }
          processToolChunk(parsed)
          return false
        }

        try {
          let lengthRetries = 0
          let correctionRetries = 0
          let consecutiveFormatFailures = 0
          let isolatedRecoveryActive = false
          let timeoutRetries = 0
          let toolCallDelivered = false
          let action: ParsedToolAction | undefined
          while (true) {
            let pending = current.pending
            xmlStream = undefined
            sawDoneSentinel = current.firstDoneSentinel === true
            if (current.firstChunk) processToolChunk(current.firstChunk)
            let timeoutRetry: ToolActionRetry | undefined
            let upstreamDone = current.firstDone
            while (!upstreamDone) {
              const frame = takeFrame(pending)
              if (frame) {
                pending = frame.rest
                upstreamDone = processToolFrame(frame.frame)
                continue
              }

              let next: ReadableStreamReadResult<Uint8Array>
              try {
                next = await current.reader.read()
              } catch (error) {
                if (!isUpstreamTimeout(error) || !refetch || timeoutRetries >= 1 || toolCallDelivered) throw error
                timeoutRetries += 1
                timeoutRetry = buildTimeoutRetry(reasoningText, content, plan, isolatedRecoveryActive)
                break
              }
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
            if (timeoutRetry) {
              const retry = timeoutRetry
              try {
                current.reader.releaseLock()
              } catch {
                // The reader may already be released after an upstream abort.
              }
              console.warn(`[proxy] tool action retry cause=timeout attempt=${timeoutRetries}/1 reasoning_chars=${reasoningText.length} content_chars=${content.length}`)
              controller.enqueue(formatSse({
                ...(identity ?? completionChunkIdentity({}, model)),
                choices: [{ index: 0, delta: { reasoning_content: encodeErrorBlock(retry) }, finish_reason: null }]
              }))
              totalUsage = mergeUsage(totalUsage, usage)
              content = ""
              usage = undefined
              upstreamFinishReason = "stop"
              reasoningText = ""
              markedProse = false
              markedProseContent = ""
              xmlStream = undefined
              sawDoneSentinel = false
              const retryFetch: ToolSseRefetch = refetch ?? (() => {
                throw new AppError("The upstream timed out before a tool action was completed", 502, "upstream_timeout")
              })
              current = await retryFetch(retry)
              continue
            }
            current.reader.releaseLock()

            if (markedProse && !isLengthTruncation(upstreamFinishReason)) {
              action = { kind: "final", content: markedProseContent }
              break
            }

            try {
              const allowAutoClose = upstreamFinishReason === "stop" && sawDoneSentinel
              action = xmlStream
                ? xmlStream.finish(allowAutoClose)
                : parseToolAction(content, plan, allowAutoClose)
              break
            } catch (error) {
              const invalidAction = error instanceof AppError && error.code === "invalid_tool_action"
              if (!invalidAction) {
                throw error
              }

              const cause: ToolActionRetryCause = isLengthTruncation(upstreamFinishReason) ? "length" : "invalid_action"
              const retryLimit = cause === "length" ? TOOL_LENGTH_CONTINUATION_MAX_RETRIES : TOOL_MODEL_CORRECTION_MAX_RETRIES
              const retryCount = cause === "length" ? lengthRetries : correctionRetries
              if (!refetch || retryCount >= retryLimit) {
                throw terminalToolActionError(error, upstreamFinishReason)
              }
              const formatFailureStreak = cause === "invalid_action" && isXmlFormatFailure(error, content)
                ? consecutiveFormatFailures + 1
                : 0
              const retry = buildToolActionRetry(error, plan, upstreamFinishReason, reasoningText, content, retryCount + 1, formatFailureStreak, isolatedRecoveryActive)
              if (cause === "length") {
                lengthRetries += 1
                consecutiveFormatFailures = 0
              } else {
                correctionRetries += 1
                consecutiveFormatFailures = formatFailureStreak
              }
              if (retry.context === "isolated") isolatedRecoveryActive = true
              console.warn(`[proxy] tool action retry cause=${retry.cause} attempt=${retryCount + 1}/${retryLimit} context=${retry.context} retry_after_ms=${retry.retryAfterMs} format_failure_streak=${formatFailureStreak} error=${error instanceof Error ? error.message : "unknown"} finish=${String(upstreamFinishReason)} reasoning_chars=${reasoningText.length} content_chars=${content.length} content_head=${JSON.stringify(content.slice(0, 160))}`)
              controller.enqueue(formatSse({
                ...(identity ?? completionChunkIdentity({}, model)),
                choices: [{ index: 0, delta: { reasoning_content: encodeErrorBlock(retry) }, finish_reason: null }]
              }))
              totalUsage = mergeUsage(totalUsage, usage)
              content = ""
              usage = undefined
              upstreamFinishReason = "stop"
              reasoningText = ""
              markedProse = false
              markedProseContent = ""
              current = await refetch(retry)
            }
          }

          identity ??= completionChunkIdentity({}, model)
          const parsedAction = action as ParsedToolAction
          if (parsedAction.kind === "tool_calls") toolCallDelivered = true
          if (parsedAction.kind === "tool_calls" && parsedAction.content !== null) {
            const progressDelta: JsonObject = roleSent
              ? { content: parsedAction.content }
              : { role: "assistant", content: parsedAction.content }
            roleSent = true
            controller.enqueue(formatSse({
              ...identity,
              choices: [{ index: 0, delta: progressDelta, finish_reason: null }]
            }))
          }

          const delta: JsonObject = roleSent ? {} : { role: "assistant" }
          let finishReason: unknown = upstreamFinishReason
          if (parsedAction.kind === "tool_calls") {
            delta.tool_calls = parsedAction.toolCalls.map((call, index) => ({ index, ...call }))
            finishReason = "tool_calls"
          } else if (!markedProse) {
            delta.content = parsedAction.content
          }
          console.info(`[proxy] tool action delivered kind=${parsedAction.kind} length_retries=${lengthRetries} correction_retries=${correctionRetries} finish=${String(upstreamFinishReason)} reasoning_chars=${reasoningText.length} content_chars=${content.length} tools=${plan.tools.length} choice=${plan.choice}`)
          controller.enqueue(formatSse({
            ...identity,
            choices: [{ index: 0, delta, finish_reason: finishReason ?? "stop" }]
          }))

          totalUsage = mergeUsage(totalUsage, usage)
          if (includeUsage && totalUsage) {
            controller.enqueue(formatSse({ ...identity, choices: [], usage: totalUsage }))
          }
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        } catch (error) {
          console.error(`[proxy] tool stream failed: ${error instanceof Error ? error.message : "unknown"} finish=${String(upstreamFinishReason)} reasoning_chars=${reasoningText.length} content_chars=${content.length} content_head=${JSON.stringify(content.slice(0, 160))}`)
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

function completionParts(normalized: JsonObject): { choice: JsonObject; message: JsonObject } | undefined {
  const choices = Array.isArray(normalized.choices) ? normalized.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const message = choice && isRecord(choice.message) ? choice.message : undefined
  return choice && message ? { choice, message } : undefined
}

export async function normalizeCompletionWithLengthContinuation(
  value: unknown,
  model: string,
  refetch?: CompletionLengthRefetch
): Promise<JsonObject> {
  let current = value
  let retries = 0
  let totalUsage: JsonObject | undefined
  let replayReasoning = ""
  let visibleContent = ""

  while (true) {
    const normalized = normalizeCompletion(current, model)
    const parts = completionParts(normalized)
    totalUsage = mergeUsage(totalUsage, isRecord(normalized.usage) ? normalized.usage : undefined)

    const reasoning = parts && typeof parts.message.reasoning_content === "string" ? parts.message.reasoning_content : ""
    const content = parts && typeof parts.message.content === "string" ? parts.message.content : ""
    if (parts && isLengthTruncation(parts.choice.finish_reason) && refetch && retries < OUTPUT_LENGTH_CONTINUATION_MAX_RETRIES) {
      const continuation = buildOutputLengthContinuation(reasoning, content)
      replayReasoning += `${continuation.reasoning}${encodeErrorBlock(continuation, {
        reasoningChars: reasoning.length,
        contentChars: content.length
      })}`
      visibleContent += content
      retries += 1
      current = await refetch(continuation)
      continue
    }

    if (parts) {
      if (replayReasoning) {
        parts.message.reasoning_content = replayReasoning + reasoning
      }
      if (visibleContent) {
        parts.message.content = visibleContent + content
      }
    }
    if (totalUsage) normalized.usage = totalUsage
    return normalized
  }
}

function toolCompletionParts(normalized: JsonObject): { choice: JsonObject; message: JsonObject } {
  const parts = completionParts(normalized)
  if (!parts) {
    throw new AppError("The upstream returned no completion for the tool request", 502, "invalid_tool_action")
  }
  return parts
}

function toolCompletionAttempt(normalized: JsonObject): { reasoning: string; content: string; finishReason: unknown } {
  const { choice, message } = toolCompletionParts(normalized)
  return {
    reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
    content: typeof message.content === "string" ? message.content : "",
    finishReason: choice.finish_reason
  }
}

function normalizeToolCompletionFromNormalized(normalized: JsonObject, plan: ToolPlan): JsonObject {
  const { choice, message } = toolCompletionParts(normalized)
  const directProse = markedProseFinal(message.content, plan)
  if (directProse !== null && !isLengthTruncation(choice.finish_reason)) {
    message.content = directProse
    return normalized
  }

  const action = parseToolAction(message.content, plan, choice.finish_reason === "stop")
  if (action.kind === "tool_calls") {
    message.content = action.content
    message.tool_calls = action.toolCalls
    delete message.function_call
    choice.finish_reason = "tool_calls"
  } else {
    message.content = action.content
  }
  return normalized
}

export function normalizeToolCompletion(value: unknown, model: string, plan: ToolPlan): JsonObject {
  return normalizeToolCompletionFromNormalized(normalizeCompletion(value, model), plan)
}

export async function normalizeToolCompletionWithRetry(
  value: unknown,
  model: string,
  plan: ToolPlan,
  refetch?: ToolCompletionRefetch
): Promise<JsonObject> {
  let current = value
  let lengthRetries = 0
  let correctionRetries = 0
  let consecutiveFormatFailures = 0
  let isolatedRecoveryActive = false
  let totalUsage: JsonObject | undefined
  let replayReasoning = ""

  while (true) {
    const normalized = normalizeCompletion(current, model)
    let attempt: { reasoning: string; content: string; finishReason: unknown } | undefined
    try {
      attempt = toolCompletionAttempt(normalized)
      const completion = normalizeToolCompletionFromNormalized(normalized, plan)
      totalUsage = mergeUsage(totalUsage, isRecord(normalized.usage) ? normalized.usage : undefined)
      if (replayReasoning) {
        const { message } = toolCompletionParts(completion)
        const finalReasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : ""
        message.reasoning_content = replayReasoning + finalReasoning
      }
      if (totalUsage) completion.usage = totalUsage
      return completion
    } catch (error) {
      const invalidAction = error instanceof AppError && error.code === "invalid_tool_action"
      if (!invalidAction) {
        throw error
      }

      const cause: ToolActionRetryCause = isLengthTruncation(attempt?.finishReason) ? "length" : "invalid_action"
      const retryLimit = cause === "length" ? TOOL_LENGTH_CONTINUATION_MAX_RETRIES : TOOL_MODEL_CORRECTION_MAX_RETRIES
      const retryCount = cause === "length" ? lengthRetries : correctionRetries
      if (!refetch || retryCount >= retryLimit) {
        throw terminalToolActionError(error, attempt?.finishReason)
      }
      const retryFetch = refetch

      const attemptContent = attempt?.content ?? ""
      const formatFailureStreak = cause === "invalid_action" && isXmlFormatFailure(error, attemptContent)
        ? consecutiveFormatFailures + 1
        : 0
      const retry = buildToolActionRetry(error, plan, attempt?.finishReason, attempt?.reasoning ?? "", attemptContent, retryCount + 1, formatFailureStreak, isolatedRecoveryActive)
      if (cause === "length") {
        lengthRetries += 1
        consecutiveFormatFailures = 0
      } else {
        correctionRetries += 1
        consecutiveFormatFailures = formatFailureStreak
      }
      if (retry.context === "isolated") isolatedRecoveryActive = true
      replayReasoning += `${retry.reasoning}${encodeErrorBlock(retry)}`
      totalUsage = mergeUsage(totalUsage, isRecord(normalized.usage) ? normalized.usage : undefined)
      current = await retryFetch(retry)
    }
  }
}
