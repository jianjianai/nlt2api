import assert from "node:assert/strict"
import test from "node:test"
import { completionFromAgentResult, createOpenAIStream } from "../server/utils/response"
import { validateChatRequest } from "../server/utils/openai"

test("normalizes a tool request without exposing internal context", () => {
  const request = validateChatRequest({
    model: "agent",
    messages: [{ role: "user", content: "读取文件" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    tool_choice: "required",
    stream: false
  })
  assert.equal(request.portalPayload.stream, false)
  assert.ok(request.toolPlan)
})

test("serializes a final Agent result as an OpenAI completion", () => {
  const body = completionFromAgentResult({ kind: "final", content: "完成", reasoning: "思考" }, "agent")
  const choice = (body.choices as Array<Record<string, unknown>>)[0]
  assert.equal(choice.finish_reason, "stop")
  assert.deepEqual(choice.message, { role: "assistant", content: "完成", reasoning_content: "思考" })
})

test("serializes a confirmed tool call as an OpenAI completion", () => {
  const body = completionFromAgentResult({
    kind: "tool_calls",
    content: null,
    reasoning: "",
    toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"package.json\"}" } }]
  }, "agent")
  const choice = (body.choices as Array<Record<string, unknown>>)[0]
  assert.equal(choice.finish_reason, "tool_calls")
  assert.equal((choice.message as Record<string, unknown>).tool_calls !== undefined, true)
})

test("emits a valid terminal SSE response", async () => {
  const stream = createOpenAIStream({ kind: "final", content: "完成", reasoning: "" }, "agent", false)
  const output = await new Response(stream).text()
  assert.match(output, /chat.completion.chunk/)
  assert.match(output, /finish_reason/)
  assert.match(output, /data: \[DONE\]/)
})
