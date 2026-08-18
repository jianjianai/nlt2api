import assert from "node:assert/strict"
import test from "node:test"
import { buildJsonToolContext, JsonToolActionError, parseJsonToolAction } from "../server/utils/tools"
import { validateChatRequest } from "../server/utils/openai"

const request = validateChatRequest({
  model: "agent",
  messages: [{ role: "user", content: "读取文件" }],
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } }],
  tool_choice: "required",
  parallel_tool_calls: false
})

assert.ok(request.toolPlan)

test("projects JSON tool definitions into the final user context", () => {
  const context = buildJsonToolContext(request.toolPlan)
  assert.match(context, /^<tool_context>/)
  assert.match(context, /read_file/)
  assert.match(context, /<~end~>/)
})

test("parses and validates a single JSON call", () => {
  const action = parseJsonToolAction("{\"name\":\"read_file\",\"arguments\":{\"path\":\"package.json\"}}", request.toolPlan)
  assert.equal(action.toolCalls[0].function.name, "read_file")
  assert.equal(action.toolCalls[0].function.arguments, "{\"path\":\"package.json\"}")
})

test("returns structured failures for malformed JSON and schema errors", () => {
  assert.throws(() => parseJsonToolAction("{broken", request.toolPlan), (error: unknown) => error instanceof JsonToolActionError && error.failure.kind === "invalid_json")
  assert.throws(() => parseJsonToolAction("{\"name\":\"read_file\",\"arguments\":{}}", request.toolPlan), (error: unknown) => error instanceof JsonToolActionError && error.failure.kind === "schema_validation")
})
