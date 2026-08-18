import assert from "node:assert/strict"
import test from "node:test"
import { ApiError } from "../../server/v2/shared/errors"
import {
  advanceAgentProtocol,
  buildAgentMessages,
  buildToolContext,
  createAgentProtocolState,
  runAgentProtocol,
  type AgentProtocolState
} from "../../server/v2/agent/protocol"
import { ChatService } from "../../server/v2/chat/service"
import { parseChatCompletionRequest } from "../../server/v2/openai/contract"
import type { JsonObject } from "../../server/v2/shared/json"

const readTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file. Keep this nested description.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Exact path to read" } },
      required: ["path"],
      additionalProperties: false
    }
  }
}

function parsed(overrides: Record<string, unknown> = {}) {
  return parseChatCompletionRequest({
    model: "agent",
    messages: [{ role: "system", content: "Agent" }, { role: "user", content: "read package.json" }],
    tools: [readTool],
    parallel_tool_calls: false,
    ...overrides
  })
}

function state(overrides: Record<string, unknown> = {}): AgentProtocolState {
  const request = parsed(overrides)
  return createAgentProtocolState({
    messages: request.messages,
    toolPlan: request.toolPlan,
    responseFormat: request.responseFormat,
    callIdPrefix: "test"
  })
}

function countContext(messages: Array<Record<string, unknown>>): number {
  return messages.filter((message) => typeof message.content === "string" && message.content.startsWith("<tool_context>")).length
}

test("places one full tool context immediately after the last real user task", () => {
  const current = state()
  const messages = buildAgentMessages(current)
  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "user"])
  assert.equal(messages[1].content, "read package.json")
  assert.equal(messages[2].content, buildToolContext(current.toolPlan, "text"))
  assert.match(messages[2].content as string, /Exact path to read/)
  assert.equal(countContext(messages), 1)
})

test("projects complete historical tool transactions while keeping tool context as the last real user turn", () => {
  const request = parsed({
    messages: [
      { role: "user", content: "read package.json" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will read " },
          { type: "text", text: "both files." }
        ],
        tool_calls: [
          { id: "call_old", type: "function", function: { name: "read_file", arguments: "{\"path\":\"package.json\"}" } },
          { id: "call_bad", type: "function", function: { name: "read_file", arguments: "{path: broken" } }
        ]
      },
      { role: "tool", tool_call_id: "call_bad", content: "rejected" },
      { role: "tool", tool_call_id: "call_old", content: "{\"name\":\"app\"}" }
    ]
  })
  const current = createAgentProtocolState({ messages: request.messages, toolPlan: request.toolPlan })
  const messages = buildAgentMessages(current)
  assert.deepEqual(messages.map((message) => message.role), ["user", "user", "assistant", "tool", "tool"])
  assert.match(messages[1].content as string, /^<tool_context>/)
  assert.equal(messages.filter((message) => message.role === "user").at(-1)?.content, messages[1].content)
  assert.equal(countContext(messages), 1)
  assert.equal(messages[2].content, "I will read both files.\n[{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}},{\"name\":\"read_file\",\"arguments\":\"{path: broken\"}]")
  assert.match(messages[3].content as string, /\"tool_call_id\":\"call_bad\"/)
  assert.match(messages[3].content as string, /\"name\":\"read_file\"/)
  assert.equal(messages[3].tool_call_id, "call_bad")
  assert.match(messages[4].content as string, /\"tool_call_id\":\"call_old\"/)
})

test("replaces failed candidates, preserves first reasoning, and never appends context after correction", () => {
  let current = state({ tool_choice: "required" })
  const first = advanceAgentProtocol(current, {
    reasoning: "first reasoning",
    content: "思考内容：embedded\n回复内容：{\"name\":\"read_file\",\"arguments\":{path:\"x\"}}",
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  })
  assert.equal(first.kind, "continue")
  assert.equal(first.kind === "continue" && first.state.firstReasoning, "first reasoning")
  current = first.state
  let messages = buildAgentMessages(current)
  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "user", "assistant", "user"])
  assert.match(messages.at(-1)?.content as string, /invalid_json/)
  assert.equal(countContext(messages), 1)
  assert.equal((messages.at(-2) as Record<string, unknown>).reasoning, "first reasoning")

  const second = advanceAgentProtocol(current, {
    reasoning: "second reasoning",
    content: "{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\""
  })
  assert.equal(second.kind, "continue")
  current = second.state
  messages = buildAgentMessages(current)
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1)
  assert.equal(messages.at(-2)?.content, "{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"")
  assert.equal((messages.at(-2) as Record<string, unknown>).reasoning, "first reasoning")
  assert.doesNotMatch(JSON.stringify(messages), /second reasoning/)
  assert.equal(countContext(messages), 1)

  const third = advanceAgentProtocol(current, {
    reasoning: "third reasoning",
    content: "回复内容：{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}}"
  })
  assert.equal(third.kind, "tool_calls")
  if (third.kind !== "tool_calls") return
  assert.equal(third.reasoning, "first reasoning")
  assert.equal(third.toolCalls[0].id, "call_test_3_0")
  assert.equal(third.toolCalls[0].function.name, "read_file")
})

test("strips embedded reasoning and reply labels before final intent parsing", () => {
  const transition = advanceAgentProtocol(state({ tool_choice: "auto" }), {
    content: "思考内容：first embedded reasoning\n回复内容：<~end~>done"
  })
  assert.equal(transition.kind, "final")
  if (transition.kind !== "final") return
  assert.equal(transition.content, "done")
  assert.equal(transition.reasoning, "first embedded reasoning")
})

test("strips same-line reasoning and reply labels without creating an empty candidate", () => {
  const transition = advanceAgentProtocol(state({ tool_choice: "auto" }), {
    content: "思考内容：先想一下 回复内容：<~end~>完成"
  })
  assert.equal(transition.kind, "final")
  if (transition.kind !== "final") return
  assert.equal(transition.reasoning, "先想一下")
  assert.equal(transition.content, "完成")

  const status = advanceAgentProtocol(state({ tool_choice: "auto" }), { content: "思考内容：只有思考" })
  assert.equal(status.kind, "continue")
  if (status.kind !== "continue") return
  assert.equal(status.state.latestCandidate, undefined)
  assert.equal(buildAgentMessages(status.state).some((message) => message.role === "assistant"), false)

  const reasoningOnly = advanceAgentProtocol(state({ tool_choice: "auto" }), {
    reasoning: "private reasoning only",
    content: ""
  })
  assert.equal(reasoningOnly.kind, "continue")
  if (reasoningOnly.kind !== "continue") return
  assert.equal(buildAgentMessages(reasoningOnly.state).some((message) => message.role === "assistant"), false)
})

test("does not allow required or named tool choice to end with a sentinel", () => {
  for (const toolChoice of ["required", { type: "function", function: { name: "read_file" } }]) {
    const transition = advanceAgentProtocol(state({ tool_choice: toolChoice }), { content: "<~end~>bypass" })
    assert.equal(transition.kind, "continue")
    if (transition.kind !== "continue") continue
    assert.equal(transition.state.latestError?.kind, "tool_required")
    const messages = buildAgentMessages(transition.state)
    assert.match(messages.at(-1)?.content as string, /tool_required/)
    assert.equal(countContext(messages), 1)
  }
})

test("retains consecutive status progress and intent prompts without adding another context", () => {
  const first = advanceAgentProtocol(state(), { content: "好的，我会继续读取" })
  assert.equal(first.kind, "continue")
  if (first.kind !== "continue") return
  assert.equal(first.visibleContent, "好的，我会继续读取")

  const second = advanceAgentProtocol(first.state, { content: "已经定位文件，继续处理" })
  assert.equal(second.kind, "continue")
  if (second.kind !== "continue") return
  assert.equal(second.visibleContent, "已经定位文件，继续处理")
  const messages = buildAgentMessages(second.state)
  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "user", "assistant", "user", "assistant", "user"])
  assert.equal(messages[3].content, "好的，我会继续读取")
  assert.match(messages[4].content as string, /^如果不继续/)
  assert.equal(messages[5].content, "已经定位文件，继续处理")
  assert.match(messages.at(-1)?.content as string, /^如果不继续/)
  assert.equal(countContext(messages), 1)
})

test("validates json_object final output locally and accumulates every round usage", async () => {
  let call = 0
  const progress: string[] = []
  const result = await runAgentProtocol({
    messages: parsed({ response_format: { type: "json_object" } }).messages,
    toolPlan: parsed({ response_format: { type: "json_object" } }).toolPlan,
    responseFormat: "json_object",
    callIdPrefix: "json",
    onProgress: (content) => { progress.push(content) },
    requestModel: async () => {
      call += 1
      if (call === 1) return { content: "working", usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, completion_tokens_details: { reasoning_tokens: 1 } } }
      if (call === 2) return { content: "<~end~>[1,2]", usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, completion_tokens_details: { reasoning_tokens: 2 } } }
      return { content: "<~end~>{\"ok\":true}", usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33, completion_tokens_details: { reasoning_tokens: 3 } } }
    }
  })

  assert.equal(result.kind, "final")
  assert.equal(result.content, "{\"ok\":true}")
  assert.equal(result.rounds, 3)
  assert.deepEqual(progress, ["working"])
  assert.deepEqual(result.usage, {
    prompt_tokens: 60,
    completion_tokens: 6,
    total_tokens: 66,
    completion_tokens_details: { reasoning_tokens: 6 }
  })
})

test("passes only the remaining completion token budget to correction rounds", async () => {
  const budgets: Array<number | undefined> = []
  let call = 0
  const result = await runAgentProtocol({
    messages: parsed().messages,
    toolPlan: parsed().toolPlan,
    maxTokens: 5,
    requestModel: async (_messages, context) => {
      budgets.push(context.maxTokens)
      call += 1
      if (call === 1) {
        return { content: "still working", usage: { completion_tokens: 2 } }
      }
      return {
        content: "{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}}",
        usage: { completion_tokens: 3 }
      }
    }
  })

  assert.equal(result.kind, "tool_calls")
  assert.deepEqual(budgets, [5, 3])
  assert.equal(result.usage?.completion_tokens, 5)
})

test("passes the remaining cumulative completion budget through ChatService", async () => {
  const payloads: JsonObject[] = []
  let call = 0
  const service = new ChatService({
    openChat: async (payload: JsonObject) => {
      payloads.push(payload)
      call += 1
      return {
        kind: "json",
        accountId: "test-account",
        value: {
          choices: [{
            message: {
              content: call === 1
                ? "working"
                : "{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}}"
            },
            finish_reason: "stop"
          }],
          usage: { completion_tokens: call === 1 ? 2 : 3 }
        }
      }
    }
  } as never, {
    getGenerationDefaults: async () => ({ temperature: 1, topP: 1, maxTokens: 999 })
  } as never)

  const response = await service.handle({
    model: "agent",
    messages: [{ role: "user", content: "read package.json" }],
    tools: [readTool],
    max_tokens: 5
  })

  assert.equal(response.kind, "json")
  assert.deepEqual(payloads.map((payload) => payload.max_tokens), [5, 3])
})

test("does not retry after a failed candidate consumes the completion token budget", async () => {
  let calls = 0
  await assert.rejects(
    () => runAgentProtocol({
      messages: parsed().messages,
      toolPlan: parsed().toolPlan,
      maxTokens: 3,
      requestModel: async () => {
        calls += 1
        return { content: "still working", usage: { completion_tokens: 3 } }
      }
    }),
    (error: unknown) => error instanceof ApiError && error.code === "agent_token_budget_exhausted"
  )
  assert.equal(calls, 1)
})

test("treats length and content_filter as terminal errors without another model request", async () => {
  for (const finishReason of ["length", "content_filter"]) {
    let calls = 0
    await assert.rejects(
      () => runAgentProtocol({
        messages: parsed().messages,
        toolPlan: parsed().toolPlan,
        requestModel: async () => {
          calls += 1
          return { content: "partial", finishReason }
        }
      }),
      (error: unknown) => error instanceof ApiError && error.code === (finishReason === "length" ? "agent_output_truncated" : "agent_content_filtered")
    )
    assert.equal(calls, 1)
  }
})

test("enforces schema, named choice, and parallel policy on model actions", () => {
  const invalidSchema = advanceAgentProtocol(state(), { content: "{\"name\":\"read_file\",\"arguments\":{}}" })
  assert.equal(invalidSchema.kind, "continue")
  assert.equal(invalidSchema.state.latestError?.kind, "schema_validation")

  const parallel = advanceAgentProtocol(state(), {
    content: "[{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}},{\"name\":\"read_file\",\"arguments\":{\"path\":\"b\"}}]"
  })
  assert.equal(parallel.kind, "continue")
  assert.equal(parallel.state.latestError?.kind, "parallel_not_allowed")

  const namedParallel = advanceAgentProtocol(state({
    tool_choice: { type: "function", function: { name: "read_file" } },
    parallel_tool_calls: true
  }), {
    content: "[{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}},{\"name\":\"read_file\",\"arguments\":{\"path\":\"b\"}}]"
  })
  assert.equal(namedParallel.kind, "tool_calls")
  if (namedParallel.kind === "tool_calls") assert.equal(namedParallel.toolCalls.length, 2)
})
