import { AppError } from "./errors"
import {
  buildJsonToolContext,
  parseJsonToolAction,
  type JsonToolActionFailure,
  type ParsedJsonToolAction,
  type ToolPlan
} from "./tools"

export type AgentMessage = Record<string, unknown> & { role: string }

export interface AgentToolResult {
  content: unknown
  isError?: boolean
}

export interface AgentModelOutput {
  content: string
  reasoning?: string
  usage?: Record<string, unknown>
  finishReason?: unknown
}

export interface AgentLoopState {
  baseMessages: AgentMessage[]
  runtimeHistory: AgentMessage[]
  firstReasoning: string | undefined
  latestCandidate: string | undefined
  latestError: JsonToolActionFailure | undefined
  correctionAttempt: number
  maxCorrectionAttempts: number
  round: number
  maxRounds: number
}

export interface AgentLoopOptions {
  baseMessages: AgentMessage[]
  toolPlan?: ToolPlan
  maxCorrectionAttempts?: number
  maxRounds?: number
  requestModel(messages: AgentMessage[]): Promise<AgentModelOutput>
  executeTool?(call: ParsedJsonToolAction["toolCalls"][number]): Promise<AgentToolResult>
}

export type AgentLoopResult =
  | {
      kind: "final"
      content: string
      reasoning: string
      usage?: Record<string, unknown>
    }
  | {
      kind: "tool_calls"
      content: string | null
      reasoning: string
      toolCalls: ParsedJsonToolAction["toolCalls"]
      usage?: Record<string, unknown>
    }

const DEFAULT_MAX_CORRECTION_ATTEMPTS = 5
const DEFAULT_MAX_ROUNDS = 12
const MAX_CORRECTION_DETAIL_CHARS = 1_000
const MAX_TOOL_RESULT_CHARS = 16_000

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => ({ ...message }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function trimDetail(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > MAX_CORRECTION_DETAIL_CHARS
    ? `${compact.slice(0, MAX_CORRECTION_DETAIL_CHARS)}...`
    : compact
}

function correctionPrompt(error: JsonToolActionFailure): string {
  const detail: Record<string, unknown> = {
    kind: error.kind,
    ...(error.message ? { message: trimDetail(error.message) } : {})
  }
  if ("toolName" in error) detail.toolName = error.toolName
  if ("index" in error) detail.index = error.index
  if ("position" in error) detail.position = error.position
  const encoded = JSON.stringify(detail)
  if (error.kind === "status_only") {
    return "继续处理原始任务。上一轮只是状态文本，没有完成任务或工具调用。请立即输出合法工具调用 JSON，或以 <~end~> 开头输出最终答案。"
  }
  return `json解析出错，请重新输出正确的json,错误详情: ${encoded}`
}

function toolResultContinuationPrompt(): string {
  return "工具结果已返回。继续处理原始任务，不要输出普通思考或状态文本；请立即输出下一个合法工具调用 JSON，或以 <~end~> 开头输出最终答案。"
}

function safeToolResult(result: AgentToolResult): string {
  const value = JSON.stringify({
    ok: result.isError !== true,
    result: result.content
  }) ?? JSON.stringify({ ok: false, result: "工具返回了不可序列化的结果" })
  return value.length > MAX_TOOL_RESULT_CHARS ? `${value.slice(0, MAX_TOOL_RESULT_CHARS)}...` : value
}

function assistantCandidate(state: AgentLoopState): AgentMessage | undefined {
  // A reasoning-only response is not a candidate; resending empty assistant content can make the upstream continue reasoning indefinitely.
  if (state.latestCandidate === undefined || state.latestCandidate.trim() === "") return undefined
  return {
    role: "assistant",
    ...(state.firstReasoning ? { reasoning: state.firstReasoning } : {}),
    content: state.latestCandidate
  }
}

export function createAgentLoopState(
  baseMessages: AgentMessage[],
  maxCorrectionAttempts = DEFAULT_MAX_CORRECTION_ATTEMPTS,
  maxRounds = DEFAULT_MAX_ROUNDS
): AgentLoopState {
  return {
    baseMessages: cloneMessages(baseMessages),
    runtimeHistory: [],
    firstReasoning: undefined,
    latestCandidate: undefined,
    latestError: undefined,
    correctionAttempt: 0,
    maxCorrectionAttempts,
    round: 0,
    maxRounds
  }
}

export function buildAgentMessages(state: AgentLoopState, toolPlan?: ToolPlan): AgentMessage[] {
  const messages = cloneMessages(state.baseMessages)
  messages.push(...cloneMessages(state.runtimeHistory))

  const candidate = assistantCandidate(state)
  if (candidate) messages.push(candidate)
  if (state.latestError) messages.push({ role: "user", content: correctionPrompt(state.latestError) })
  if (messages.at(-1)?.role === "tool") messages.push({ role: "user", content: toolResultContinuationPrompt() })

  messages.push({ role: "user", content: buildJsonToolContext(toolPlan) })
  return messages
}

function updateCandidate(state: AgentLoopState, output: AgentModelOutput, error: JsonToolActionFailure): void {
  if (state.firstReasoning === undefined) state.firstReasoning = output.reasoning ?? ""
  state.latestCandidate = output.content
  state.latestError = error
  state.correctionAttempt += 1
}

function clearCandidate(state: AgentLoopState): void {
  state.latestCandidate = undefined
  state.latestError = undefined
  state.correctionAttempt = 0
}

function assertCorrectionBudget(state: AgentLoopState): void {
  if (state.correctionAttempt <= state.maxCorrectionAttempts) return
  throw new AppError(
    "The agent exceeded the maximum number of JSON correction attempts",
    502,
    "agent_correction_limit"
  )
}

function assertRoundBudget(state: AgentLoopState): void {
  if (state.round < state.maxRounds) return
  throw new AppError("The agent exceeded the maximum number of model rounds", 502, "agent_round_limit")
}

function appendToolExecution(
  state: AgentLoopState,
  output: AgentModelOutput,
  action: ParsedJsonToolAction,
  results: AgentToolResult[]
): void {
  state.runtimeHistory.push({
    role: "assistant",
    ...(output.reasoning ? { reasoning: output.reasoning } : {}),
    content: output.content,
    tool_calls: action.toolCalls
  })
  for (let index = 0; index < action.toolCalls.length; index += 1) {
    const call = action.toolCalls[index]
    const result = results[index] ?? { content: "The tool did not return a result", isError: true }
    state.runtimeHistory.push({
      role: "tool",
      tool_call_id: call.id,
      content: safeToolResult(result)
    })
  }
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const state = createAgentLoopState(
    options.baseMessages,
    options.maxCorrectionAttempts ?? DEFAULT_MAX_CORRECTION_ATTEMPTS,
    options.maxRounds ?? DEFAULT_MAX_ROUNDS
  )
  let lastUsage: Record<string, unknown> | undefined

  while (true) {
    assertRoundBudget(state)
    state.round += 1
    const output = await options.requestModel(buildAgentMessages(state, options.toolPlan))
    if (lastUsage === undefined && output.usage) lastUsage = output.usage
    if (state.firstReasoning === undefined) state.firstReasoning = output.reasoning ?? ""

    const trimmed = output.content.trimStart()
    if (trimmed.startsWith("<~end~>")) {
      clearCandidate(state)
      return {
        kind: "final",
        content: trimmed.slice("<~end~>".length).trimStart(),
        reasoning: state.firstReasoning,
        ...(lastUsage ? { usage: lastUsage } : {})
      }
    }

    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      updateCandidate(state, output, {
        kind: "status_only",
        message: "The response did not start with a JSON tool call or the final sentinel"
      })
      assertCorrectionBudget(state)
      continue
    }

    let action: ParsedJsonToolAction
    try {
      action = parseJsonToolAction(output.content, options.toolPlan)
    } catch (error) {
      const failure = error instanceof Error && "failure" in error && isRecord(error.failure)
        ? error.failure as JsonToolActionFailure
        : { kind: "invalid_json" as const, message: "The JSON tool action could not be parsed" }
      updateCandidate(state, output, failure)
      assertCorrectionBudget(state)
      continue
    }

    clearCandidate(state)
    if (!options.executeTool) {
      return {
        kind: "tool_calls",
        content: action.content,
        reasoning: output.reasoning ?? state.firstReasoning,
        toolCalls: action.toolCalls,
        ...(lastUsage ? { usage: lastUsage } : {})
      }
    }

    const results: AgentToolResult[] = []
    for (const call of action.toolCalls) {
      try {
        results.push(await options.executeTool(call))
      } catch (error) {
        results.push({
          isError: true,
          content: { code: "tool_execution_error", message: error instanceof Error ? trimDetail(error.message) : "The tool execution failed" }
        })
      }
    }
    appendToolExecution(state, output, action, results)
  }
}
