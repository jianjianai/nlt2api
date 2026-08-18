import assert from "node:assert/strict"
import test from "node:test"
import { buildAgentMessages, runAgentLoop, type AgentMessage } from "../server/utils/agent-loop"
import { validateChatRequest } from "../server/utils/openai"

const readTool = {
  type: "function",
  function: {
    name: "read_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }
  }
}

function plan() {
  const request = validateChatRequest({
    model: "agent",
    messages: [{ role: "user", content: "读取 package.json" }],
    tools: [readTool],
    tool_choice: "required",
    parallel_tool_calls: false
  })
  assert.ok(request.toolPlan)
  return request.toolPlan
}

test("replaces the failed candidate and preserves the first reasoning snapshot", async () => {
  const messages: AgentMessage[][] = []
  let call = 0
  const result = await runAgentLoop({
    baseMessages: [{ role: "system", content: "Agent" }, { role: "user", content: "读取 package.json" }],
    toolPlan: plan(),
    requestModel: async (current) => {
      messages.push(current)
      call += 1
      if (call === 1) return { reasoning: "first reasoning", content: "{\"name\":\"read_file\",\"arguments\":{path:\"package.json\"}}" }
      if (call === 2) return { reasoning: "second reasoning", content: "{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}" }
      return { reasoning: "third reasoning", content: "<~end~>已完成" }
    }
  })

  assert.equal(result.kind, "final")
  assert.equal(result.content, "已完成")
  assert.equal(messages.length, 3)
  assert.equal(messages[1].filter((item) => item.role === "assistant").length, 1)
  assert.equal(messages[2].filter((item) => item.role === "assistant").length, 1)
  const latestAssistant = messages[2].find((item) => item.role === "assistant")
  assert.equal(latestAssistant?.content, "{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}")
  assert.equal(latestAssistant?.reasoning, "first reasoning")
  assert.match(messages[1].filter((item) => item.role === "user")[1]?.content as string, /invalid_json/)
  assert.match(messages[2].filter((item) => item.role === "user")[1]?.content as string, /invalid_json/)
  assert.doesNotMatch(JSON.stringify(messages[2]), /first reasoning.*second reasoning/)
})

test("does not resend a reasoning-only response as empty assistant content", async () => {
  const messages: AgentMessage[][] = []
  let call = 0
  const result = await runAgentLoop({
    baseMessages: [{ role: "user", content: "读取 package.json" }],
    toolPlan: plan(),
    requestModel: async (current) => {
      messages.push(current)
      call += 1
      if (call <= 2) return { reasoning: `第 ${call} 次分析`, content: "" }
      return { content: "{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}}" }
    }
  })

  assert.equal(result.kind, "tool_calls")
  assert.equal(messages.length, 3)
  assert.equal(messages[1].filter((item) => item.role === "assistant").length, 0)
  assert.equal(messages[2].filter((item) => item.role === "assistant").length, 0)
  assert.match(messages[1].filter((item) => item.role === "user")[1]?.content as string, /上一轮只是状态文本/)
})

test("puts tool context in the final user message and submits legal calls once", async () => {
  const messages: AgentMessage[][] = []
  let executed = 0
  const result = await runAgentLoop({
    baseMessages: [{ role: "system", content: "Agent" }, { role: "user", content: "读取 package.json" }],
    toolPlan: plan(),
    requestModel: async (current) => {
      messages.push(current)
      if (messages.length === 1) return { content: "{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}}" }
      return { content: "<~end~>工具结果已处理" }
    },
    executeTool: async (call) => {
      executed += 1
      assert.equal(call.function.name, "read_file")
      return { content: { content: "{}" } }
    }
  })

  assert.equal(executed, 1)
  assert.equal(result.kind, "final")
  assert.equal(result.content, "工具结果已处理")
  assert.equal(messages.length, 2)
  const second = messages[1]
  assert.equal(second.at(-1)?.role, "user")
  assert.match(second.at(-2)?.content as string, /工具结果已返回/)
  assert.match(second.at(-2)?.content as string, /合法工具调用 JSON/)
  assert.match(second.at(-1)?.content as string, /^<tool_context>/)
  assert.equal(second.filter((item) => item.role === "assistant").length, 1)
  assert.equal(second.filter((item) => item.role === "tool").length, 1)
})

test("returns a structured correction-limit error", async () => {
  await assert.rejects(
    () => runAgentLoop({
      baseMessages: [{ role: "user", content: "task" }],
      toolPlan: plan(),
      maxCorrectionAttempts: 1,
      requestModel: async () => ({ content: "{ broken" })
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "agent_correction_limit"
  )
})

test("buildAgentMessages never appends a failed candidate to runtime history", () => {
  const request = validateChatRequest({
    model: "agent",
    messages: [{ role: "user", content: "task" }],
    tools: [readTool]
  })
  const stateMessages = buildAgentMessages({
    baseMessages: [{ role: "user", content: "task" }],
    runtimeHistory: [],
    firstReasoning: "first",
    latestCandidate: "{bad}",
    latestError: { kind: "invalid_json", message: "bad JSON" },
    correctionAttempt: 1,
    maxCorrectionAttempts: 5,
    round: 1,
    maxRounds: 12
  }, request.toolPlan)
  assert.equal(stateMessages.filter((item) => item.role === "assistant").length, 1)
  assert.equal(stateMessages.at(-1)?.role, "user")
  assert.match(stateMessages.at(-1)?.content as string, /<tool_context>/)
})
