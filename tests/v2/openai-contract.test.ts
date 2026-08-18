import assert from "node:assert/strict"
import test from "node:test"
import { ApiError } from "../../server/v2/shared/errors"
import { MAX_TOOL_COUNT, MAX_TOOL_SCHEMA_BYTES } from "../../server/v2/shared/limits"
import {
  parseChatCompletionRequest,
  type FunctionToolPlan
} from "../../server/v2/openai/contract"

const readTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file without changing it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to read" }
      },
      required: ["path"],
      additionalProperties: false
    }
  }
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof ApiError && error.code === code)
}

function request(overrides: Record<string, unknown> = {}) {
  return parseChatCompletionRequest({
    model: " kimi-k3 ",
    messages: [{ role: "user", content: "hello" }],
    ...overrides
  })
}

test("normalizes the documented request subset with OpenAI stream defaults", () => {
  const parsed = request({
    n: 1,
    temperature: 0,
    top_p: 1,
    max_tokens: 3,
    max_completion_tokens: 99,
    reasoning_effort: "high",
    metadata: { test: true }
  })

  assert.equal(parsed.model, "kimi-k3")
  assert.equal(parsed.stream, false)
  assert.equal(parsed.temperature, 0)
  assert.equal(parsed.topP, 1)
  assert.equal(parsed.maxTokens, 3)
  assert.equal(parsed.portalPayload.max_tokens, 3)
  assert.equal(parsed.portalPayload.stream, false)
  assert.deepEqual(parsed.ignoredFields, ["reasoning_effort", "metadata"])

  const mapped = request({ max_completion_tokens: 7 })
  assert.equal(mapped.maxTokens, 7)
  assert.equal(mapped.portalPayload.max_tokens, 7)
})

test("rejects unsupported multiplicity and validates numeric ranges", () => {
  expectCode(() => request({ n: 2 }), "unsupported_parameter")
  expectCode(() => request({ n: 0 }), "invalid_parameter")
  expectCode(() => request({ temperature: -0.01 }), "invalid_parameter")
  expectCode(() => request({ temperature: 2.01 }), "invalid_parameter")
  expectCode(() => request({ top_p: -0.01 }), "invalid_parameter")
  expectCode(() => request({ top_p: 1.01 }), "invalid_parameter")
  expectCode(() => request({ max_tokens: 0 }), "invalid_parameter")
  expectCode(() => request({ unknown_field: true }), "unsupported_parameter")
})

test("does not raise a caller token limit for tool protocol overhead", () => {
  const parsed = request({ tools: [readTool], max_tokens: 1 })
  assert.equal(parsed.maxTokens, 1)
  assert.equal(parsed.portalPayload.max_tokens, 1)
})

test("accepts a complete assistant tool transaction with omitted content", () => {
  const parsed = request({
    messages: [
      { role: "user", content: "read both" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
          { id: "call_b", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b\"}" } }
        ]
      },
      { role: "tool", tool_call_id: "call_b", content: "B" },
      { role: "tool", tool_call_id: "call_a", content: "A" },
      { role: "user", content: "continue" }
    ]
  })

  assert.equal(parsed.messages[1].content, null)
  assert.equal(parsed.messages[1].tool_calls?.length, 2)
})

test("preserves opaque historical tool arguments for model-side recovery", () => {
  const parsed = request({
    messages: [
      { role: "user", content: "recover" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_bad", type: "function", function: { name: "read_file", arguments: "{path: broken" } },
          { id: "call_empty", type: "function", function: { name: "read_file", arguments: "" } }
        ]
      },
      { role: "tool", tool_call_id: "call_bad", content: "rejected" },
      { role: "tool", tool_call_id: "call_empty", content: "no arguments" }
    ]
  })
  assert.equal(parsed.messages[1].tool_calls?.[0].function.arguments, "{path: broken")
  assert.equal(parsed.messages[1].tool_calls?.[1].function.arguments, "")
})

test("rejects incomplete, interrupted, duplicate, and orphan tool results", () => {
  const assistant = {
    role: "assistant",
    tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } }]
  }
  expectCode(() => request({ messages: [{ role: "user", content: "x" }, assistant] }), "invalid_tool_history")
  expectCode(() => request({ messages: [{ role: "user", content: "x" }, assistant, { role: "user", content: "interrupt" }] }), "invalid_tool_history")
  expectCode(() => request({ messages: [{ role: "user", content: "x" }, assistant, { role: "tool", tool_call_id: "call_a", content: "ok" }, { role: "tool", tool_call_id: "call_a", content: "again" }] }), "invalid_tool_history")
  expectCode(() => request({ messages: [{ role: "user", content: "x" }, { role: "tool", tool_call_id: "call_a", content: "orphan" }] }), "invalid_tool_history")
  expectCode(() => request({ messages: [{ role: "assistant" }] }), "invalid_message")
  expectCode(() => request({ messages: [{ role: "assistant", content: null }] }), "invalid_message")
})

test("supports auto, none, required, and both documented named choice shapes", () => {
  assert.equal(request({ tools: [readTool] }).toolPlan?.choice, "auto")
  assert.equal(request({ tools: [readTool], tool_choice: "none" }).toolPlan?.choice, "none")
  assert.equal(request({ tools: [readTool], tool_choice: "required" }).toolPlan?.choice, "required")

  const standard = request({
    tools: [readTool],
    tool_choice: { type: "function", function: { name: "read_file" } },
    parallel_tool_calls: true
  }).toolPlan
  assert.equal(standard?.choice, "named")
  assert.equal(standard?.namedTool, "read_file")
  assert.equal(standard?.parallel, true)

  const documentedFlat = request({ tools: [readTool], tool_choice: { type: "function", name: "read_file" } }).toolPlan
  assert.equal(documentedFlat?.choice, "named")
  expectCode(() => request({ tools: [readTool], tool_choice: { type: "function", name: "missing" } }), "invalid_parameter")
  expectCode(() => request({ tools: [readTool], tool_choice: { type: "function", function: { name: "read_file", extra: true } } }), "unsupported_parameter")
})

test("compiles and enforces draft-06, draft-07, 2019-09, and 2020-12 schemas", () => {
  const dialects = [
    "http://json-schema.org/draft-06/schema#",
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema"
  ]

  for (const dialect of dialects) {
    const tool = {
      type: "function",
      function: {
        name: "send_email",
        description: `schema ${dialect}`,
        parameters: {
          $schema: dialect,
          type: "object",
          properties: { email: { type: "string", format: "email", description: "Destination" } },
          required: ["email"],
          additionalProperties: false
        }
      }
    }
    const plan = request({ tools: [tool] }).toolPlan as FunctionToolPlan
    assert.equal(plan.tools[0].validate({ email: "person@example.com" }), true, dialect)
    assert.equal(plan.tools[0].validate({ email: "not-an-email" }), false, dialect)
    assert.equal(plan.tools[0].function.description, `schema ${dialect}`)
    assert.equal((plan.tools[0].function.parameters.properties as Record<string, unknown>).email !== undefined, true)
  }
})

test("isolates schema ids across tools and requests without breaking local refs", () => {
  const schema = {
    $id: "https://schemas.example.test/shared-tool.json",
    type: "object",
    definitions: {
      value: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false
      }
    },
    $ref: "#/definitions/value"
  }
  const first = request({
    tools: [
      { type: "function", function: { name: "first", parameters: schema } },
      { type: "function", function: { name: "second", parameters: schema } }
    ]
  })
  const second = request({
    tools: [{ type: "function", function: { name: "third", parameters: schema } }]
  })

  assert.equal(first.toolPlan?.tools[0].validate({ value: "a" }), true)
  assert.equal(first.toolPlan?.tools[1].validate({ value: "b" }), true)
  assert.equal(second.toolPlan?.tools[0].validate({ value: "c" }), true)
  assert.equal(first.toolPlan?.tools[0].validate({ value: 1 }), false)
  assert.equal(second.toolPlan?.tools[0].validate({ unexpected: true }), false)
})

test("enforces tool count and aggregate schema byte limits", () => {
  const tooMany = Array.from({ length: MAX_TOOL_COUNT + 1 }, (_, index) => ({
    type: "function",
    function: { name: `tool_${index}`, parameters: { type: "object" } }
  }))
  expectCode(() => request({ tools: tooMany }), "tool_limit_exceeded")

  const oversized = [{
    type: "function",
    function: {
      name: "huge",
      description: "x".repeat(MAX_TOOL_SCHEMA_BYTES),
      parameters: { type: "object" }
    }
  }]
  expectCode(() => request({ tools: oversized }), "tool_schema_limit_exceeded")
})

test("validates stream options only for streaming requests", () => {
  expectCode(() => request({ stream_options: { include_usage: true } }), "invalid_parameter")
  const parsed = request({ stream: true, stream_options: { include_usage: true, include_obfuscation: false } })
  assert.equal(parsed.includeUsage, true)
  assert.equal(parsed.includeObfuscation, false)
})
