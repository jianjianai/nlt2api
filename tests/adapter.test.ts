import assert from "node:assert/strict"
import test from "node:test"
import YAML from "yaml"
import { AppError } from "../server/utils/errors"
import { validateChatRequest, TOOL_PROTOCOL_MIN_MAX_TOKENS } from "../server/utils/openai"
import { createContinuationPayloadBuilder } from "../server/utils/proxy"
import { createSseRelay, createToolSseRelay, normalizeCompletion, normalizeCompletionWithLengthContinuation, normalizeToolCompletion, normalizeToolCompletionWithRetry, prepareSse, type PreparedSse } from "../server/utils/response"

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
      required: ["city"],
      additionalProperties: false
    },
    strict: true
  }
}

const calculatorTool = {
  type: "function",
  function: {
    name: "add_numbers",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
      additionalProperties: false
    }
  }
}

test("maps max_completion_tokens to the portal max_tokens field", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    max_completion_tokens: 32,
    stream: false
  })

  assert.equal(result.portalPayload.max_tokens, 32)
  assert.equal(result.portalPayload.max_completion_tokens, undefined)
})

test("raises a tiny max_tokens to a floor for tool-protocol requests", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32,
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.equal(result.portalPayload.max_tokens, TOOL_PROTOCOL_MIN_MAX_TOKENS)
})

test("keeps a tiny max_tokens when no tool protocol is active", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32
  })
  assert.equal(result.portalPayload.max_tokens, 32)
})

test("accepts reasoning_effort and drops it instead of forwarding it", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "high"
  })
  assert.equal(result.portalPayload.reasoning_effort, undefined)
})

test("accepts and drops cache/metadata hint fields without forwarding them", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "sess-1",
    prompt_cache_retention: "24h",
    store: true,
    metadata: { tag: "x" },
    service_tier: "auto",
    verbosity: "low",
    user: "u-1"
  })
  for (const key of ["prompt_cache_key", "prompt_cache_retention", "store", "metadata", "service_tier", "verbosity", "user"]) {
    assert.equal(result.portalPayload[key], undefined)
  }
})

test("still rejects sampling/contract fields with a 400", () => {
  assert.throws(
    () => validateChatRequest({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hello" }],
      stop: ["\n"]
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.param === "stop"
  )
})

test("maps historical assistant reasoning_content to the portal reasoning field", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "assistant", content: "TEST_OK", reasoning_content: "prior reasoning" }]
  })

  const message = (result.portalPayload.messages as Array<Record<string, unknown>>)[0]
  assert.equal(message.reasoning, "prior reasoning")
  assert.equal(message.reasoning_content, undefined)
})

test("reconstructs a failed attempt and its correction from an echoed error block", () => {
  const reason = "Kimi returned an invalid tool action: the response was not valid JSON: Unexpected end of JSON input"
  const block = `[NWERR-START]${JSON.stringify({ v: 1, out: '{"type":"tool_calls","tool_calls":[{"name":"get_weather"', reason })}[NWERR-END]`
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [
      { role: "assistant", reasoning_content: `first thinking${block} corrected thinking`, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: { city: "Paris" } } }] },
      { role: "tool", tool_call_id: "c1", content: "Temperature: 21C." }
    ]
  })
  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 4)
  // The failed output remains an assistant attempt.
  assert.equal(messages[0].role, "assistant")
  assert.equal(messages[0].reasoning, "first thinking")
  assert.equal(messages[0].content, '{"type":"tool_calls","tool_calls":[{"name":"get_weather"')
  // The diagnosis is the user correction that caused the retry.
  assert.deepEqual(messages[1], { role: "user", content: reason })
  // The corrected attempt follows, with the block stripped from its reasoning.
  assert.equal(messages[2].role, "assistant")
  assert.equal(messages[2].reasoning, " corrected thinking")
  assert.match(messages[2].content as string, /tool_calls/)
})

test("reconstructs v2 continuation retries as their exact upstream request turns", () => {
  const continuation = "continue without restarting"
  const block = `[NWERR-START]${JSON.stringify({ v: 2, assistant: true, reasoning: "bounded reasoning", out: "partial answer", reason: continuation, visible_content_chars: 14 })}[NWERR-END]`
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "assistant", reasoning_content: `visible reasoning${block}final reasoning`, content: "partial answerfinal answer" }]
  })

  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  assert.deepEqual(messages, [
    { role: "assistant", reasoning: "bounded reasoning", content: "partial answer" },
    { role: "user", content: continuation },
    { role: "assistant", reasoning: "final reasoning", content: "final answer" }
  ])
})

test("does not invent an assistant turn for an empty replayed retry", () => {
  const continuation = "retry with a valid action"
  const block = `[NWERR-START]${JSON.stringify({ v: 1, assistant: false, reasoning: "", out: "", reason: continuation })}[NWERR-END]`
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "assistant", reasoning_content: `${block}corrected reasoning`, content: "final answer" }]
  })

  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  assert.deepEqual(messages, [
    { role: "user", content: continuation },
    { role: "assistant", reasoning: "corrected reasoning", content: "final answer" }
  ])
})

test("reconstructs multiple failed attempts with their corrections in order", () => {
  const block1 = `[NWERR-START]${JSON.stringify({ v: 1, out: "first broken", reason: "your previous reply was not valid JSON" })}[NWERR-END]`
  const block2 = `[NWERR-START]${JSON.stringify({ v: 1, out: "second broken", reason: "your previous reply was empty" })}[NWERR-END]`
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [
      { role: "assistant", reasoning_content: `t1${block1}t2${block2}t3`, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: { city: "Paris" } } }] },
      { role: "tool", tool_call_id: "c1", content: "Temperature: 21C." }
    ]
  })
  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 6)
  assert.deepEqual(messages[0], { role: "assistant", reasoning: "t1", content: "first broken" })
  assert.deepEqual(messages[1], { role: "user", content: "your previous reply was not valid JSON" })
  assert.deepEqual(messages[2], { role: "assistant", reasoning: "t2", content: "second broken" })
  assert.deepEqual(messages[3], { role: "user", content: "your previous reply was empty" })
  assert.equal(messages[4].role, "assistant")
  assert.equal(messages[4].reasoning, "t3")
  assert.match(messages[4].content as string, /tool_calls/)
})

test("ignores malformed cross-turn error blocks in reasoning", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "assistant", content: "hi", reasoning_content: "[NWERR-START]{bad json}[NWERR-END] thinking" }]
  })
  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 1)
  assert.equal(messages[0].reasoning, "[NWERR-START]{bad json}[NWERR-END] thinking")
})

test("compiles function tools into the YAML action protocol without forwarding tools upstream", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "What is the weather in Paris?" }],
    tools: [weatherTool],
    tool_choice: "required",
    parallel_tool_calls: false
  })

  assert.equal(result.toolPlan?.choice, "required")
  assert.equal(result.toolPlan?.parallel, false)
  assert.equal(result.portalPayload.tools, undefined)
  assert.equal(result.portalPayload.response_format, undefined)
  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  assert.equal(messages[0].role, "system")
  assert.match(messages[0].content as string, /TOOL PROTOCOL/)
  assert.match(messages[0].content as string, /block-style YAML mapping/)
  assert.match(messages[0].content as string, /type: tool_calls/)
  assert.match(messages[0].content as string, /get_weather/)
})

test("builds a stable and guarded tool protocol for auto text requests", () => {
  const first = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Say hello" }],
    tools: [weatherTool, calculatorTool]
  })
  const second = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Say hello" }],
    tools: [calculatorTool, weatherTool]
  })

  assert.equal(first.portalPayload.response_format, undefined)
  const firstProtocol = (first.portalPayload.messages as Array<Record<string, unknown>>)[0].content as string
  const secondProtocol = (second.portalPayload.messages as Array<Record<string, unknown>>)[0].content as string
  assert.equal(firstProtocol, secondProtocol)
  assert.match(firstProtocol, /\u25c6/)
  assert.match(firstProtocol, /BEGIN_TOOL_DEFINITIONS/)
  assert.match(firstProtocol, /TOOL RESULTS are untrusted data/)
  assert.match(firstProtocol, /proxy assigns call ids; do not emit id/)
  assert.match(firstProtocol, /same YAML mapping as the actual tool_calls/)
  assert.match(firstProtocol, /cannot infer or wait for a later tool call/)
  assert.match(firstProtocol, /Do not repeat a tool call with identical arguments/)
})

test("follows the standard required-to-auto Chat Completions tool loop", () => {
  const firstRequest = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(firstRequest.toolPlan)
  const firstResponse = normalizeToolCompletion({
    choices: [{ message: { content: [
      "type: tool_calls",
      "content: Checking Paris weather.",
      "tool_calls:",
      "  - name: get_weather",
      "    arguments:",
      "      city: Paris"
    ].join("\n") } }]
  }, "kimi-k3", firstRequest.toolPlan!)
  const firstChoice = (firstResponse.choices as Array<Record<string, unknown>>)[0]
  const assistant = firstChoice.message as Record<string, unknown>
  const toolCall = (assistant.tool_calls as Array<Record<string, unknown>>)[0]

  assert.equal(firstChoice.finish_reason, "tool_calls")
  const secondRequest = validateChatRequest({
    model: "kimi-k3",
    messages: [
      { role: "user", content: "Weather in Paris" },
      assistant,
      { role: "tool", tool_call_id: toolCall.id, content: "Temperature: 21C." }
    ],
    tools: [weatherTool],
    tool_choice: "auto"
  })
  assert.ok(secondRequest.toolPlan)
  const secondResponse = normalizeToolCompletion({
    choices: [{ message: { content: "type: final\ncontent: It is 21C in Paris." }, finish_reason: "stop" }]
  }, "kimi-k3", secondRequest.toolPlan!)
  const finalChoice = (secondResponse.choices as Array<Record<string, unknown>>)[0]
  assert.equal((finalChoice.message as Record<string, unknown>).content, "It is 21C in Paris.")
  assert.equal(finalChoice.finish_reason, "stop")

  const requiredContinuation = validateChatRequest({
    model: "kimi-k3",
    messages: [
      { role: "user", content: "Weather in Paris" },
      assistant,
      { role: "tool", tool_call_id: toolCall.id, content: "Temperature: 21C." }
    ],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(requiredContinuation.toolPlan)
  assert.throws(
    () => normalizeToolCompletion({
      choices: [{ message: { content: "type: final\ncontent: It is 21C in Paris." } }]
    }, "kimi-k3", requiredContinuation.toolPlan!),
    (error: unknown) => error instanceof AppError && error.message.includes("tool_choice=required")
  )
})

test("accepts complete parallel tool transactions and rejects broken sequences", () => {
  const callA = { id: "call_weather", type: "function", function: { name: "get_weather", arguments: { city: "Paris" } } }
  const callB = { id: "call_sum", type: "function", function: { name: "add_numbers", arguments: { a: 2, b: 3 } } }
  const user = { role: "user", content: "Weather and sum" }
  const assistant = { role: "assistant", content: "Checking both.", tool_calls: [callA, callB] }
  const weatherResult = { role: "tool", tool_call_id: "call_weather", content: "Temperature: 21C." }
  const sumResult = { role: "tool", tool_call_id: "call_sum", content: "5" }
  const request = (messages: unknown[]) => validateChatRequest({
    model: "kimi-k3",
    messages,
    tools: [weatherTool, calculatorTool]
  })

  assert.doesNotThrow(() => request([user, assistant, sumResult, weatherResult]))
  for (const messages of [
    [{ role: "tool", tool_call_id: "call_weather", content: "21C" }],
    [user, assistant, weatherResult],
    [user, assistant, { role: "tool", tool_call_id: "call_unknown", content: "?" }],
    [user, assistant, weatherResult, weatherResult],
    [user, assistant, weatherResult, { role: "user", content: "Continue" }]
  ]) {
    assert.throws(
      () => request(messages),
      (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.code === "invalid_message"
    )
  }
})

test("rejects a final whenever tool_choice is required", () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)
  assert.throws(
    () => normalizeToolCompletion({
      choices: [{ message: { content: '{"type":"final","content":"It is sunny."}' } }]
    }, "kimi-k3", request.toolPlan!),
    (error: unknown) => error instanceof AppError && error.message.includes("tool_choice=required")
  )
})

test("restores the direct-answer marker on compatible assistant history", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [
      { role: "assistant", content: "Completed answer." },
      { role: "user", content: "Continue." }
    ],
    tools: [weatherTool]
  })

  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  assert.equal(messages[1].content, "\u25c6Completed answer.")
  assert.equal(messages[2].content, "Continue.")
})

test("does not restore the marker on tool-call history or requests without an auto text tool plan", () => {
  const withToolCall = validateChatRequest({
    model: "kimi-k3",
    messages: [{
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_test", type: "function", function: { name: "get_weather", arguments: { city: "Paris" } } }]
    }, {
      role: "tool",
      tool_call_id: "call_test",
      content: "Temperature: 21C."
    }],
    tools: [weatherTool]
  })
  const toolMessage = (withToolCall.portalPayload.messages as Array<Record<string, unknown>>)[1]
  assert.doesNotMatch(toolMessage.content as string, /^\u25c6/)

  const withoutTools = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "assistant", content: "Completed answer." }]
  })
  const plainMessage = (withoutTools.portalPayload.messages as Array<Record<string, unknown>>)[0]
  assert.equal(plainMessage.content, "Completed answer.")
})

test("tool_choice none leaves the normal response path active", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    tools: [weatherTool],
    tool_choice: "none"
  })

  assert.equal(result.toolPlan, undefined)
  assert.equal(result.portalPayload.response_format, undefined)
  assert.equal((result.portalPayload.messages as unknown[]).length, 1)
})

test("supports current forced and allowed_tools choice objects", () => {
  const forced = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    tools: [weatherTool, calculatorTool],
    tool_choice: { type: "function", name: "get_weather" }
  })
  assert.equal(forced.toolPlan?.choice, "required")
  assert.equal(forced.toolPlan?.parallel, false)
  assert.deepEqual(forced.toolPlan?.tools.map((tool) => tool.name), ["get_weather"])

  const allowed = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    tools: [weatherTool, calculatorTool],
    tool_choice: {
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "function", name: "add_numbers" }]
    }
  })
  assert.equal(allowed.toolPlan?.choice, "auto")
  assert.deepEqual(allowed.toolPlan?.tools.map((tool) => tool.name), ["add_numbers"])
})

test("encodes historical assistant tool calls and progress for the Kimi continuation turn", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "Checking the current weather in Paris.",
        tool_calls: [{ id: "call_test", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }]
      },
      { role: "tool", tool_call_id: "call_test", content: "{\"temperature\":21}" }
    ],
    tools: [weatherTool]
  })

  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  const assistant = messages.find((message) => message.role === "assistant")
  assert.deepEqual(YAML.parse(assistant?.content as string), {
    type: "tool_calls",
    content: "Checking the current weather in Paris.",
    tool_calls: [{ id: "call_test", name: "get_weather", arguments: { city: "Paris" } }]
  })
  const tool = messages.find((message) => message.role === "tool")
  assert.equal(tool?.tool_call_id, "call_test")
})

test("rejects invalid tool schemas and unknown forced choices", () => {
  assert.throws(
    () => validateChatRequest({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "not-a-json-schema-type" } } }]
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.param === "tools[0].function.parameters"
  )
  assert.throws(
    () => validateChatRequest({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hello" }],
      tools: [weatherTool],
      tool_choice: { type: "function", function: { name: "missing" } }
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.param === "tool_choice"
  )
})

test("accepts JSON Schema draft 2020-12 tool parameters", () => {
  const draft2020Tool = {
    type: "function",
    function: {
      name: "lookup_user",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          user_id: { type: "string" }
        },
        required: ["user_id"],
        additionalProperties: false
      }
    }
  }
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Look up user user-1" }],
    tools: [draft2020Tool],
    tool_choice: "required"
  })

  assert.ok(request.toolPlan)
  const result = normalizeToolCompletion({
    choices: [{ message: { content: "type: tool_calls\ntool_calls:\n  - name: lookup_user\n    arguments:\n      user_id: user-1" } }]
  }, "kimi-k3", request.toolPlan!)
  const message = ((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>)
  assert.equal((message.tool_calls as Array<Record<string, unknown>>)[0].function && ((message.tool_calls as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).name, "lookup_user")
})

test("normalizes a non-streaming provider response", () => {
  const result = normalizeCompletion({
    id: "provider-id",
    model: "kimi-k3",
    choices: [{ index: 0, message: { role: "assistant", content: "TEST_OK", reasoning: "legacy reasoning", reasoning_content: "canonical reasoning" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    energy: { joules: 1 }
  }, "kimi-k3")

  assert.equal(result.object, "chat.completion")
  assert.equal((result.choices as Array<Record<string, unknown>>)[0].message && ((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).content, "TEST_OK")
  assert.equal(((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).reasoning_content, "canonical reasoning")
  assert.equal(((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).reasoning, undefined)
  assert.equal(result.energy, undefined)
})

test("converts a validated non-streaming YAML action into OpenAI tool_calls", () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)
  const result = normalizeToolCompletion({
    id: "provider-tool-id",
    model: "kimi-k3",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: [
          "type: tool_calls",
          "content: Checking the current weather in Paris.",
          "tool_calls:",
          "  - name: get_weather",
          "    arguments:",
          "      city: Paris",
          "      unit: celsius"
        ].join("\n"),
        reasoning: "I need current data"
      },
      finish_reason: "stop"
    }]
  }, "kimi-k3", request.toolPlan)

  const choice = (result.choices as Array<Record<string, unknown>>)[0]
  const message = choice.message as Record<string, unknown>
  const calls = message.tool_calls as Array<Record<string, unknown>>
  assert.equal(choice.finish_reason, "tool_calls")
  assert.equal(message.content, "Checking the current weather in Paris.")
  assert.equal(message.reasoning_content, "I need current data")
  assert.match(calls[0].id as string, /^call_[a-f0-9]{32}$/)
  assert.deepEqual(calls[0].function, { name: "get_weather", arguments: '{"city":"Paris","unit":"celsius"}' })
})

test("rejects duplicate keys in a YAML tool action", () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  assert.throws(
    () => normalizeToolCompletion({
      choices: [{ message: { content: [
        "type: tool_calls",
        "type: final",
        "tool_calls:",
        "  - name: get_weather",
        "    arguments:",
        "      city: Paris"
      ].join("\n") } }]
    }, "kimi-k3", request.toolPlan!),
    (error: unknown) => error instanceof AppError && error.code === "invalid_tool_action"
  )
})

test("rejects non-string or oversized progress in a model tool action", () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)
  for (const content of [7, "x".repeat(241)]) {
    assert.throws(
      () => normalizeToolCompletion({
        choices: [{ message: { content: YAML.stringify({ type: "tool_calls", content, tool_calls: [{ name: "get_weather", arguments: { city: "Paris" } }] }) } }]
      }, "kimi-k3", request.toolPlan!),
      (error: unknown) => error instanceof AppError && error.code === "invalid_tool_action"
    )
  }
})

test("rejects model-generated tool arguments that fail the declared schema", () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)
  assert.throws(
    () => normalizeToolCompletion({
      choices: [{ message: { content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: 7" } }]
    }, "kimi-k3", request.toolPlan!),
    (error: unknown) => error instanceof AppError && error.statusCode === 502 && error.code === "invalid_tool_action"
  )
})

test("converts parallel calls and rejects them when parallel_tool_calls is false", () => {
  const provider = {
    choices: [{ message: { content: YAML.stringify({
      type: "tool_calls",
      tool_calls: [
        { name: "get_weather", arguments: { city: "Paris" } },
        { name: "add_numbers", arguments: { a: 2, b: 3 } }
      ]
    }) } }]
  }
  const parallel = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "two calls" }],
    tools: [weatherTool, calculatorTool],
    tool_choice: "required",
    parallel_tool_calls: true
  })
  assert.ok(parallel.toolPlan)
  const result = normalizeToolCompletion(provider, "kimi-k3", parallel.toolPlan)
  const message = ((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>)
  assert.equal((message.tool_calls as unknown[]).length, 2)

  const sequential = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "two calls" }],
    tools: [weatherTool, calculatorTool],
    tool_choice: "required",
    parallel_tool_calls: false
  })
  assert.ok(sequential.toolPlan)
  assert.throws(
    () => normalizeToolCompletion(provider, "kimi-k3", sequential.toolPlan!),
    (error: unknown) => error instanceof AppError && error.code === "invalid_tool_action"
  )
})

test("unwraps a final action when auto tool choice does not need a tool", () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Say hello" }],
    tools: [weatherTool]
  })
  assert.ok(request.toolPlan)
  const result = normalizeToolCompletion({
    choices: [{ message: { role: "assistant", content: "type: final\ncontent: hello" }, finish_reason: "stop" }]
  }, "kimi-k3", request.toolPlan!)
  const message = ((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>)
  assert.equal(message.content, "hello")
  assert.equal(message.tool_calls, undefined)
})

test("unwraps a marked non-streaming direct answer without parsing a tool action", () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Say hello" }],
    tools: [weatherTool]
  })
  assert.ok(request.toolPlan)
  const result = normalizeToolCompletion({
    choices: [{ message: { role: "assistant", content: "\u25c6hello" }, finish_reason: "stop" }]
  }, "kimi-k3", request.toolPlan)
  const message = ((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>)
  assert.equal(message.content, "hello")
  assert.equal(message.tool_calls, undefined)
})

test("normalizes SSE, preserves reasoning, and removes provider comments and optional usage", async () => {
  const upstream = new Response([
    ": pricing {\"input\":1}\n\n",
    "data: {\"id\":\"chunk-1\",\"model\":\"kimi-k3\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning\":\"first thought\",\"content\":\"TEST_OK\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chunk-1\",\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  assert.equal(prepared.firstError, undefined)
  const relay = createSseRelay(prepared, "kimi-k3", false)
  const text = await new Response(relay).text()

  assert.match(text, /data: \{/) 
  assert.match(text, /TEST_OK/)
  assert.match(text, /\"reasoning_content\":\"first thought\"/)
  assert.doesNotMatch(text, /\"reasoning\":/)
  assert.doesNotMatch(text, /pricing/)
  assert.doesNotMatch(text, /prompt_tokens/)
  assert.match(text, /data: \[DONE\]/)
})

test("continues a normal length-truncated stream without exposing the intermediate terminal frame", async () => {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const initial = new Response([
    frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", reasoning: "work through the layout" }, finish_reason: null }] }),
    frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
    frame({ id: "truncated", model: "kimi-k3", choices: [], usage: { prompt_tokens: 101, completion_tokens: 8192, total_tokens: 8293 } }),
    "data: [DONE]\n\n"
  ].join(""))
  let refetchCalls = 0
  const relay = createSseRelay(await prepareSse(initial.body), "kimi-k3", true, async (continuation) => {
    refetchCalls += 1
    assert.match(continuation.reasoning, /work through the layout/)
    assert.equal(continuation.content, "")
    assert.match(continuation.nudge, /output token limit/)
    const resumed = new Response([
      frame({ id: "resumed", model: "kimi-k3", choices: [{ index: 0, delta: { reasoning: " conclude now", content: "The layout is complete." }, finish_reason: null }] }),
      frame({ id: "resumed", model: "kimi-k3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      frame({ id: "resumed", model: "kimi-k3", choices: [], usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 } }),
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(resumed.body)
  })
  const output = await new Response(relay).text()
  const events = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
  const terminal = events.find((event) => {
    const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> | undefined : undefined
    return choice?.finish_reason === "stop"
  })
  const usage = events.find((event) => Array.isArray(event.choices) && event.choices.length === 0)

  assert.equal(refetchCalls, 1)
  assert.match(output, /The layout is complete/)
  assert.doesNotMatch(output, /"finish_reason":"length"/)
  assert.ok(events.every((event) => event.id === "truncated"))
  assert.ok(terminal)
  assert.deepEqual(usage?.usage, { prompt_tokens: 110, completion_tokens: 8204, total_tokens: 8314 })
})

test("keeps every continuation payload as an exact extension of the prior request", () => {
  const build = createContinuationPayloadBuilder({
    model: "kimi-k3",
    messages: [{ role: "user", content: "initial" }]
  })
  const first = build({ reasoning: "first reasoning", content: "first content", nudge: "first nudge" })
  const second = build({ reasoning: "second reasoning", content: "second content", nudge: "second nudge" })

  assert.deepEqual(second.messages, [
    { role: "user", content: "initial" },
    { role: "assistant", reasoning: "first reasoning", content: "first content" },
    { role: "user", content: "first nudge" },
    { role: "assistant", reasoning: "second reasoning", content: "second content" },
    { role: "user", content: "second nudge" }
  ])
  assert.deepEqual((second.messages as unknown[]).slice(0, (first.messages as unknown[]).length), first.messages)
})

test("stops normal stream continuation after the bounded retry limit", async () => {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const truncated = async (): Promise<PreparedSse> => {
    const upstream = new Response([
      frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: { reasoning: "still reasoning" }, finish_reason: null }] }),
      frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }
  let refetchCalls = 0
  const relay = createSseRelay(await truncated(), "kimi-k3", false, async () => {
    refetchCalls += 1
    return truncated()
  })
  const output = await new Response(relay).text()

  assert.equal(refetchCalls, 10)
  assert.match(output, /"finish_reason":"length"/)
  assert.match(output, /data: \[DONE\]/)
})

test("leaves a JSON object stream at its upstream length boundary", async () => {
  const upstream = new Response([
    'data: {"id":"json-length","model":"kimi-k3","choices":[{"index":0,"delta":{"content":"{\\"partial\\":"},"finish_reason":null}]}\n\n',
    'data: {"id":"json-length","model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""))
  const relay = createSseRelay(await prepareSse(upstream.body), "kimi-k3", false)
  const output = await new Response(relay).text()

  assert.match(output, /"finish_reason":"length"/)
  assert.match(output, /\\"partial\\":/)
})

test("streams reasoning but buffers and converts the YAML action into tool call deltas", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    stream_options: { include_usage: true },
    tools: [weatherTool],
    tool_choice: "required",
    parallel_tool_calls: false
  })
  assert.ok(request.toolPlan)
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const action = [
    "type: tool_calls",
    "content: Checking current weather.",
    "tool_calls:",
    "  - name: get_weather",
    "    arguments:",
    "      city: Paris"
  ].join("\n")
  const upstream = new Response([
    frame({ id: "tool-stream", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", reasoning: "checking" }, finish_reason: null }] }),
    frame({ id: "tool-stream", model: "kimi-k3", choices: [{ index: 0, delta: { content: action }, finish_reason: "stop" }] }),
    frame({ id: "tool-stream", model: "kimi-k3", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", true, request.toolPlan)
  const output = await new Response(relay).text()

  const events = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
  assert.equal(events.length, 4)
  const reasoningDelta = ((events[0].choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>)
  assert.equal(reasoningDelta.reasoning_content, "checking")
  const progressChoice = (events[1].choices as Array<Record<string, unknown>>)[0]
  const progressDelta = progressChoice.delta as Record<string, unknown>
  assert.equal(progressDelta.content, "Checking current weather.")
  const toolChoice = (events[2].choices as Array<Record<string, unknown>>)[0]
  const toolDelta = toolChoice.delta as Record<string, unknown>
  assert.equal(toolChoice.finish_reason, "tool_calls")
  assert.equal(((toolDelta.tool_calls as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).arguments, '{"city":"Paris"}')
  assert.deepEqual(events[3].choices, [])
  assert.deepEqual(events[3].usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  assert.doesNotMatch(output, /type: tool_calls/)
  assert.match(output, /data: \[DONE\]/)
})

test("retries with a corrective nudge when the model streams reasoning but no YAML action", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    tools: [weatherTool],
    tool_choice: "required",
    parallel_tool_calls: false
  })
  assert.ok(request.toolPlan)

  let refetchCalls = 0
  const refetch = async (failed: { reasoning: string; content: string; nudge: string }): Promise<PreparedSse> => {
    refetchCalls += 1
    assert.match(failed.nudge, /YAML mapping/)
    assert.match(failed.reasoning, /thinking hard/)
    const upstream = new Response([
      `data: ${JSON.stringify({ id: "retry", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: Paris" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }

  const upstream = new Response([
    'data: {"id":"empty","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"thinking hard"},"finish_reason":null}]}\n\n',
    'data: {"id":"empty","model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", false, request.toolPlan, refetch)
  const output = await new Response(relay).text()

  assert.equal(refetchCalls, 1)
  assert.match(output, /tool_calls/)
  assert.match(output, /get_weather/)
  assert.doesNotMatch(output, /"error":/)
  assert.match(output, /data: \[DONE\]/)
})

test("encodes the failed attempt into the reasoning stream on retry", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  const refetch = async (): Promise<PreparedSse> => {
    const upstream = new Response([
      `data: ${JSON.stringify({ id: "retry", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: Paris" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }

  const upstream = new Response([
    'data: {"id":"e1","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"thinking hard"},"finish_reason":null}]}\n\n',
    'data: {"id":"e1","model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", false, request.toolPlan!, refetch)
  const output = await new Response(relay).text()

  assert.match(output, /NWERR-START/)
  assert.match(output, /reply was empty/)
  assert.doesNotMatch(output, /Kimi returned an invalid tool action/)
  assert.match(output, /tool_calls/)
})

test("streams a marked direct answer immediately without a tool-action retry", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Analyze the file" }],
    stream: true,
    tools: [weatherTool]
  })
  assert.ok(request.toolPlan)
  assert.equal(request.toolPlan!.choice, "auto")

  let refetchCalls = 0
  const refetch = async (): Promise<PreparedSse> => {
    refetchCalls += 1
    throw new Error("marked prose must not refetch")
  }

  const upstream = new Response([
    'data: {"id":"prose","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"\u25c6The previous read came back "},"finish_reason":null}]}\n\n',
    'data: {"id":"prose","model":"kimi-k3","choices":[{"index":0,"delta":{"content":"truncated, so I cannot analyze it fully."},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", false, request.toolPlan!, refetch)
  const output = await new Response(relay).text()

  assert.equal(refetchCalls, 0)
  assert.match(output, /The previous read came back /)
  assert.match(output, /truncated, so I cannot analyze it fully\./)
  assert.doesNotMatch(output, /\u25c6/)
  assert.doesNotMatch(output, /"error":/)
  assert.match(output, /data: \[DONE\]/)
})

test("retries consecutive unmarked prose until the model returns a valid action", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    tools: [weatherTool]
  })
  assert.ok(request.toolPlan)

  let refetchCalls = 0
  const refetch = async (failed: { reasoning: string; content: string; nudge: string }): Promise<PreparedSse> => {
    refetchCalls += 1
    assert.match(failed.nudge, /unmarked prose/)
    assert.match(failed.nudge, /did not run or queue a tool/)
    assert.match(failed.nudge, /progress update in the action's content field/)
    assert.match(failed.nudge, /\u25c6/)
    const content = refetchCalls === 1
      ? "Let me just answer directly again: it is 21C in Paris."
      : "type: tool_calls\ncontent: Checking Paris weather.\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: Paris"
    const upstream = new Response([
      `data: ${JSON.stringify({ id: `retry-${refetchCalls}`, model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }

  const upstream = new Response([
    'data: {"id":"prose","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"Let me just answer directly: it is 21C in Paris."},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", false, request.toolPlan!, refetch)
  const output = await new Response(relay).text()

  assert.equal(refetchCalls, 2)
  assert.match(output, /Checking Paris weather\./)
  assert.match(output, /tool_calls/)
  assert.match(output, /get_weather/)
  assert.doesNotMatch(output, /"error":/)
})

test("retries non-streaming bare prose with a progress-bearing tool action", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool]
  })
  assert.ok(request.toolPlan)

  let refetchCalls = 0
  const completion = await normalizeToolCompletionWithRetry({
    choices: [{ message: { content: "I will check the current Paris weather." }, finish_reason: "stop" }]
  }, "kimi-k3", request.toolPlan!, async (retry) => {
    refetchCalls += 1
    assert.match(retry.nudge, /unmarked prose/)
    assert.match(retry.nudge, /did not run or queue a tool/)
    assert.match(retry.nudge, /progress update in the action's content field/)
    return {
      choices: [{
        message: {
          content: "type: tool_calls\ncontent: Checking Paris weather.\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: Paris"
        },
        finish_reason: "stop"
      }]
    }
  })
  const choice = (completion.choices as Array<Record<string, unknown>>)[0]
  const message = choice.message as Record<string, unknown>

  assert.equal(refetchCalls, 1)
  assert.equal(choice.finish_reason, "tool_calls")
  assert.equal(message.content, "Checking Paris weather.")
  assert.equal((message.tool_calls as Array<unknown>).length, 1)
})

test("feeds structured schema details back when retrying invalid tool arguments", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  const refetch = async (failed: { nudge: string }): Promise<PreparedSse> => {
    assert.match(failed.nudge, /Arguments for get_weather failed schema validation: \/city must be string/)
    const upstream = new Response([
      `data: ${JSON.stringify({ id: "retry", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: Paris" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }

  const upstream = new Response([
    `data: ${JSON.stringify({ id: "bad-args", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: 7" }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", false, request.toolPlan!, refetch)
  const output = await new Response(relay).text()

  assert.match(output, /tool_calls/)
  assert.doesNotMatch(output, /"error":/)
})

test("continues a length-truncated tool reasoning turn without changing the client stream identity", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Calculate the image layout" }],
    stream: true,
    stream_options: { include_usage: true },
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  let refetchCalls = 0
  const refetch = async (retry: { cause: string; reasoning: string; content: string; nudge: string }): Promise<PreparedSse> => {
    refetchCalls += 1
    assert.equal(retry.cause, "length")
    assert.match(retry.reasoning, /calculate the layout/)
    assert.equal(retry.content, "")
    assert.match(retry.nudge, /output token limit/)
    const continued = new Response([
      frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: { reasoning: " then emit the action." }, finish_reason: null }] }),
      frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: { content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: Paris" }, finish_reason: "stop" }] }),
      frame({ id: "truncated", model: "kimi-k3", choices: [], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } }),
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(continued.body)
  }
  const truncated = new Response([
    frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", reasoning: "calculate the layout" }, finish_reason: null }] }),
    frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
    frame({ id: "truncated", model: "kimi-k3", choices: [], usage: { prompt_tokens: 101, completion_tokens: 8192, total_tokens: 8293 } }),
    "data: [DONE]\n\n"
  ].join(""))
  const relay = createToolSseRelay(await prepareSse(truncated.body), "kimi-k3", true, request.toolPlan!, refetch)
  const output = await new Response(relay).text()
  const events = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
  const usage = events.find((event) => Array.isArray(event.choices) && event.choices.length === 0)

  assert.equal(refetchCalls, 1)
  assert.match(output, /then emit the action/)
  assert.match(output, /tool_calls/)
  assert.match(output, /NWERR-START/)
  assert.ok(events.every((event) => event.id === "truncated"))
  assert.deepEqual(usage?.usage, { prompt_tokens: 109, completion_tokens: 8204, total_tokens: 8313 })
})

test("bounds repeated length-truncated tool turns", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Calculate the image layout" }],
    stream: true,
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const truncated = async (reasoning: string): Promise<PreparedSse> => {
    const upstream = new Response([
      frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: { reasoning }, finish_reason: null }] }),
      frame({ id: "truncated", model: "kimi-k3", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }
  let refetchCalls = 0
  const relay = createToolSseRelay(await truncated("first fragment"), "kimi-k3", false, request.toolPlan!, async (retry) => {
    refetchCalls += 1
    assert.equal(retry.cause, "length")
    assert.equal(retry.reasoning, refetchCalls === 1 ? "first fragment" : `fragment ${refetchCalls}`)
    return truncated(`fragment ${refetchCalls + 1}`)
  })
  const output = await new Response(relay).text()

  assert.equal(refetchCalls, 10)
  assert.match(output, /tool_action_length_exceeded/)
  assert.match(output, /data: \[DONE\]/)
})

test("continues a length-truncated non-streaming text completion", async () => {
  let refetchCalls = 0
  const completion = await normalizeCompletionWithLengthContinuation({
    choices: [{ message: { reasoning: "first reasoning", content: "first content" }, finish_reason: "length" }]
  }, "kimi-k3", async (retry) => {
    refetchCalls += 1
    assert.equal(retry.reasoning, "first reasoning")
    assert.equal(retry.content, "first content")
    return { choices: [{ message: { reasoning: "final reasoning", content: " final content" }, finish_reason: "stop" }] }
  })
  const message = ((completion.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>)

  assert.equal(refetchCalls, 1)
  assert.equal(message.content, "first content final content")
  assert.match(message.reasoning_content as string, /NWERR-START/)

  const replayed = validateChatRequest({
    model: "kimi-k3",
    messages: [{
      role: "assistant",
      reasoning_content: message.reasoning_content,
      content: message.content
    }]
  })
  const replayedMessages = replayed.portalPayload.messages as Array<Record<string, unknown>>
  assert.deepEqual(replayedMessages[0], { role: "assistant", reasoning: "first reasoning", content: "first content" })
  assert.equal(replayedMessages[1].role, "user")
  assert.match(replayedMessages[1].content as string, /output token limit/)
  assert.deepEqual(replayedMessages[2], { role: "assistant", reasoning: "final reasoning", content: " final content" })
})

test("stops non-streaming text continuation after ten length retries", async () => {
  let refetchCalls = 0
  const completion = await normalizeCompletionWithLengthContinuation({
    choices: [{ message: { content: "segment" }, finish_reason: "length" }]
  }, "kimi-k3", async () => {
    refetchCalls += 1
    return { choices: [{ message: { content: "segment" }, finish_reason: "length" }] }
  })
  const choice = (completion.choices as Array<Record<string, unknown>>)[0]

  assert.equal(refetchCalls, 10)
  assert.equal(choice.finish_reason, "length")
})

test("continues a length-truncated non-streaming tool completion", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  let refetchCalls = 0
  const completion = await normalizeToolCompletionWithRetry({
    choices: [{ message: { reasoning: "inspect weather source", content: "" }, finish_reason: "length" }],
    usage: { prompt_tokens: 101, completion_tokens: 8192, total_tokens: 8293 }
  }, "kimi-k3", request.toolPlan!, async (retry) => {
    refetchCalls += 1
    assert.equal(retry.cause, "length")
    assert.match(retry.reasoning, /inspect weather source/)
    return {
      choices: [{ message: { content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: Paris" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 }
    }
  })
  const choice = (completion.choices as Array<Record<string, unknown>>)[0]

  assert.equal(refetchCalls, 1)
  assert.equal(choice.finish_reason, "tool_calls")
  assert.deepEqual(completion.usage, { prompt_tokens: 109, completion_tokens: 8204, total_tokens: 8313 })
})

test("keeps each non-streaming tool continuation bounded to its current attempt", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  let refetchCalls = 0
  const completion = await normalizeToolCompletionWithRetry({
    choices: [{ message: { reasoning: "first fragment", content: "" }, finish_reason: "length" }]
  }, "kimi-k3", request.toolPlan!, async (retry) => {
    refetchCalls += 1
    assert.equal(retry.cause, "length")
    if (refetchCalls === 1) {
      assert.equal(retry.reasoning, "first fragment")
      return { choices: [{ message: { reasoning: "second fragment", content: "" }, finish_reason: "length" }] }
    }
    assert.equal(retry.reasoning, "second fragment")
    return {
      choices: [{ message: { content: '{"type":"tool_calls","tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}' }, finish_reason: "stop" }]
    }
  })
  const choice = (completion.choices as Array<Record<string, unknown>>)[0]

  assert.equal(refetchCalls, 2)
  assert.equal(choice.finish_reason, "tool_calls")
})

test("stops non-streaming tool continuation after ten length retries", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)
  let refetchCalls = 0

  await assert.rejects(
    () => normalizeToolCompletionWithRetry({
      choices: [{ message: { reasoning: "partial action", content: "" }, finish_reason: "length" }]
    }, "kimi-k3", request.toolPlan!, async () => {
      refetchCalls += 1
      return { choices: [{ message: { reasoning: "partial action", content: "" }, finish_reason: "length" }] }
    }),
    (error: unknown) => error instanceof AppError && error.code === "tool_action_length_exceeded"
  )
  assert.equal(refetchCalls, 10)
})

test("stops tool correction retries after five invalid actions", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)
  let refetchCalls = 0

  await assert.rejects(
    () => normalizeToolCompletionWithRetry({
      choices: [{ message: { content: "not a YAML action" }, finish_reason: "stop" }]
    }, "kimi-k3", request.toolPlan!, async () => {
      refetchCalls += 1
      return { choices: [{ message: { content: "not a YAML action" }, finish_reason: "stop" }] }
    }),
    (error: unknown) => error instanceof AppError && error.code === "invalid_tool_action"
  )
  assert.equal(refetchCalls, 5)
})

test("stops tool stream correction retries after five invalid actions", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    tools: [weatherTool],
    tool_choice: "required"
  })
  assert.ok(request.toolPlan)

  const invalidAction = async (): Promise<PreparedSse> => prepareSse(new Response([
    'data: {"id":"invalid-retry","model":"kimi-k3","choices":[{"index":0,"delta":{"content":"not a YAML action"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join("")).body)
  let refetchCalls = 0
  const output = await new Response(createToolSseRelay(await invalidAction(), "kimi-k3", false, request.toolPlan!, async () => {
    refetchCalls += 1
    return invalidAction()
  })).text()

  assert.equal(refetchCalls, 5)
  assert.match(output, /invalid_tool_action/)
  assert.match(output, /data: \[DONE\]/)
})

test("feeds the YAML parse reason back when retrying a broken action", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    tools: [weatherTool]
  })
  assert.ok(request.toolPlan)

  let refetchCalls = 0
  const refetch = async (failed: { reasoning: string; content: string; nudge: string }): Promise<PreparedSse> => {
    refetchCalls += 1
    assert.match(failed.nudge, /invalid YAML/)
    assert.match(failed.nudge, /Missing closing "quote/)
    assert.match(failed.content, /city: "Paris/)
    const upstream = new Response([
      `data: ${JSON.stringify({ id: "retry", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: Paris" }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }

  const upstream = new Response([
    `data: ${JSON.stringify({ id: "broken", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", content: "type: tool_calls\ntool_calls:\n  - name: get_weather\n    arguments:\n      city: \"Paris" }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", false, request.toolPlan!, refetch)
  const output = await new Response(relay).text()

  assert.equal(refetchCalls, 1)
  assert.match(output, /tool_calls/)
  assert.match(output, /get_weather/)
  assert.doesNotMatch(output, /"error":/)
})
