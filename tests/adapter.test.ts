import assert from "node:assert/strict"
import test from "node:test"
import { AppError } from "../server/utils/errors"
import { validateChatRequest, TOOL_PROTOCOL_MIN_MAX_TOKENS } from "../server/utils/openai"
import { createSseRelay, createToolSseRelay, normalizeCompletion, normalizeToolCompletion, prepareSse, type PreparedSse } from "../server/utils/response"

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

test("compiles function tools into the JSON action protocol without forwarding tools upstream", () => {
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
  assert.deepEqual(result.portalPayload.response_format, { type: "json_object" })
  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  assert.equal(messages[0].role, "system")
  assert.match(messages[0].content as string, /TOOL PROTOCOL/)
  assert.match(messages[0].content as string, /get_weather/)
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

test("encodes historical assistant tool calls for the Kimi continuation turn", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_test", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }]
      },
      { role: "tool", tool_call_id: "call_test", content: "{\"temperature\":21}" }
    ],
    tools: [weatherTool]
  })

  const messages = result.portalPayload.messages as Array<Record<string, unknown>>
  const assistant = messages.find((message) => message.role === "assistant")
  assert.deepEqual(JSON.parse(assistant?.content as string), {
    type: "tool_calls",
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
    choices: [{ message: { content: '{"type":"tool_calls","tool_calls":[{"name":"lookup_user","arguments":{"user_id":"user-1"}}]}' } }]
  }, "kimi-k3", request.toolPlan)
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

test("converts a validated non-streaming JSON action into OpenAI tool_calls", () => {
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
        content: '{"type":"tool_calls","tool_calls":[{"id":"call_0","name":"get_weather","arguments":{"city":"Paris","unit":"celsius"}}]}',
        reasoning: "I need current data"
      },
      finish_reason: "stop"
    }]
  }, "kimi-k3", request.toolPlan)

  const choice = (result.choices as Array<Record<string, unknown>>)[0]
  const message = choice.message as Record<string, unknown>
  const calls = message.tool_calls as Array<Record<string, unknown>>
  assert.equal(choice.finish_reason, "tool_calls")
  assert.equal(message.content, null)
  assert.equal(message.reasoning_content, "I need current data")
  assert.match(calls[0].id as string, /^call_[a-f0-9]{32}$/)
  assert.deepEqual(calls[0].function, { name: "get_weather", arguments: '{"city":"Paris","unit":"celsius"}' })
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
      choices: [{ message: { content: '{"type":"tool_calls","tool_calls":[{"name":"get_weather","arguments":{"city":7}}]}' } }]
    }, "kimi-k3", request.toolPlan!),
    (error: unknown) => error instanceof AppError && error.statusCode === 502 && error.code === "invalid_tool_action"
  )
})

test("converts parallel calls and rejects them when parallel_tool_calls is false", () => {
  const provider = {
    choices: [{ message: { content: JSON.stringify({
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
    choices: [{ message: { role: "assistant", content: '{"type":"final","content":"hello"}' }, finish_reason: "stop" }]
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

test("streams reasoning but buffers and converts the JSON action into tool call deltas", async () => {
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
  const upstream = new Response([
    'data: {"id":"tool-stream","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"checking"},"finish_reason":null}]}\n\n',
    'data: {"id":"tool-stream","model":"kimi-k3","choices":[{"index":0,"delta":{"content":"{\\\"type\\\":\\\"tool_calls\\\",\\\"tool_calls\\\":[{\\\"name\\\":\\\"get_weather\\\","},"finish_reason":null}]}\n\n',
    'data: {"id":"tool-stream","model":"kimi-k3","choices":[{"index":0,"delta":{"content":"\\\"arguments\\\":{\\\"city\\\":\\\"Paris\\\"}}]}"},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"tool-stream","model":"kimi-k3","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", true, request.toolPlan)
  const output = await new Response(relay).text()

  const events = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
  assert.equal(events.length, 3)
  const reasoningDelta = ((events[0].choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>)
  assert.equal(reasoningDelta.reasoning_content, "checking")
  const toolChoice = (events[1].choices as Array<Record<string, unknown>>)[0]
  const toolDelta = toolChoice.delta as Record<string, unknown>
  assert.equal(toolChoice.finish_reason, "tool_calls")
  assert.equal(((toolDelta.tool_calls as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).arguments, '{"city":"Paris"}')
  assert.deepEqual(events[2].choices, [])
  assert.deepEqual(events[2].usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  assert.doesNotMatch(output, /\\\"type\\\":\\\"tool_calls\\\"/)
  assert.match(output, /data: \[DONE\]/)
})

test("retries with a corrective nudge when the model streams reasoning but no JSON action", async () => {
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
  const refetch = async (nudge: string): Promise<PreparedSse> => {
    refetchCalls += 1
    assert.match(nudge, /JSON object/)
    const upstream = new Response([
      'data: {"id":"retry","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\\"type\\\":\\\"tool_calls\\\",\\\"tool_calls\\\":[{\\\"name\\\":\\\"get_weather\\\",\\\"arguments\\\":{\\\"city\\\":\\\"Paris\\\"}}]}"},"finish_reason":"stop"}]}\n\n',
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
  assert.doesNotMatch(output, /invalid tool action/)
  assert.match(output, /data: \[DONE\]/)
})

test("delivers prose as final when auto choice has no retry left", async () => {
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
    const upstream = new Response([
      'data: {"id":"prose2","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"The previous read came back truncated, so I cannot analyze it fully."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }

  const upstream = new Response([
    'data: {"id":"prose1","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"The previous read came back truncated, so I cannot analyze it fully."},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", false, request.toolPlan!, refetch)
  const output = await new Response(relay).text()

  assert.equal(refetchCalls, 1)
  assert.match(output, /came back truncated/)
  assert.doesNotMatch(output, /invalid tool action/)
  assert.match(output, /data: \[DONE\]/)
})

test("retries prose first when a retry is available (auto choice keeps tool preference)", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    tools: [weatherTool]
  })
  assert.ok(request.toolPlan)

  let refetchCalls = 0
  const refetch = async (nudge: string): Promise<PreparedSse> => {
    refetchCalls += 1
    assert.match(nudge, /prose/)
    const upstream = new Response([
      'data: {"id":"retry","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\\"type\\\":\\\"tool_calls\\\",\\\"tool_calls\\\":[{\\\"name\\\":\\\"get_weather\\\",\\\"arguments\\\":{\\\"city\\\":\\\"Paris\\\"}}]}"},"finish_reason":"stop"}]}\n\n',
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

  assert.equal(refetchCalls, 1)
  assert.match(output, /tool_calls/)
  assert.match(output, /get_weather/)
  assert.doesNotMatch(output, /invalid tool action/)
})

test("feeds the JSON parse reason back when retrying broken JSON", async () => {
  const request = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Weather in Paris" }],
    stream: true,
    tools: [weatherTool]
  })
  assert.ok(request.toolPlan)

  let refetchCalls = 0
  const refetch = async (nudge: string): Promise<PreparedSse> => {
    refetchCalls += 1
    assert.match(nudge, /parser reported/)
    const upstream = new Response([
      'data: {"id":"retry","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\\"type\\\":\\\"tool_calls\\\",\\\"tool_calls\\\":[{\\\"name\\\":\\\"get_weather\\\",\\\"arguments\\\":{\\\"city\\\":\\\"Paris\\\"}}]}"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n"
    ].join(""))
    return prepareSse(upstream.body)
  }

  // Truncated JSON action: starts with {, so it must be retried (not treated
  // as a prose final) and the retry nudge must carry the parser's reason.
  const upstream = new Response([
    'data: {"id":"broken","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\\"type\\\":\\\"tool_calls\\\",\\\"tool_calls\\\":[{\\\"name\\\":\\\"get_weather\\\",\\\"arguments\\\":{\\\"city\\\":\\\"Paris\\\""},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  const relay = createToolSseRelay(prepared, "kimi-k3", false, request.toolPlan!, refetch)
  const output = await new Response(relay).text()

  assert.equal(refetchCalls, 1)
  assert.match(output, /tool_calls/)
  assert.match(output, /get_weather/)
  assert.doesNotMatch(output, /invalid tool action/)
})
