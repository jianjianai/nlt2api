import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_REPLY_MARKER,
  REPAIR_REASONING_START,
  InvalidStructuredToolCallsError,
  stripRepairReasoning,
  tagRepairReasoning,
  buildToolRepairHistory,
  envelopeAllowedForToolChoice,
  normaliseAssistantToolCalls,
  parseControlledToolEnvelope,
  parseControlledToolEnvelopeDetailed,
  withToolCallContract,
} from "../server/utils/tool-calls.ts";
import {
  parseAndValidateToolArguments,
  jsonSchemaCacheStats,
  validateJsonSchema,
  validateSchemaDefinition,
} from "../server/utils/json-schema.ts";
import { responsesStreamEvents } from "../server/utils/responses-events.ts";
import {
  responseCompatibilityFields,
  responseEnvelopeFields,
  responseUsage,
} from "../server/utils/responses-compat.ts";
import {
  collectUpstreamStream,
  openAIStreamingSse,
  openAISse,
  UpstreamStreamError,
} from "../server/utils/upstream-stream.ts";
import { redact } from "../server/utils/redaction.ts";

const tools = [{
  type: "function" as const,
  function: {
    name: "calculator",
    parameters: {
      type: "object",
      properties: {
        a: { type: "integer" },
        b: { type: "integer" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
}];

test("controlled envelope produces stable OpenAI tool calls", () => {
  const envelope = parseControlledToolEnvelope(
    JSON.stringify({
      type: "tool_calls",
      tool_calls: [{ name: "calculator", arguments: { a: 29, b: 13 } }],
    }),
    tools,
    "chatcmpl-test",
  );

  assert.equal(envelope?.type, "tool_calls");
  if (envelope?.type !== "tool_calls") return;
  assert.equal(envelope.toolCalls.length, 1);
  assert.equal(envelope.toolCalls[0]?.id, "call_chatcmpltest_1");
  assert.deepEqual(JSON.parse(envelope.toolCalls[0]!.function.arguments), { a: 29, b: 13 });
});

test("duplicate structured call IDs are regenerated without collisions", () => {
  const normalized = normaliseAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "same", type: "function", function: { name: "calculator", arguments: '{"a":1,"b":2}' } },
      { id: "same", type: "function", function: { name: "calculator", arguments: '{"a":3,"b":4}' } },
    ],
  }, tools, "seed");
  assert.equal(new Set(normalized.tool_calls?.map((call) => call.id)).size, 2);
  assert.equal(normalized.tool_calls?.[0]?.id, "same");
  assert.notEqual(normalized.tool_calls?.[1]?.id, "same");
});

test("controlled envelope rejects undeclared or non-object calls", () => {
  assert.equal(parseControlledToolEnvelope(
    '{"type":"tool_calls","tool_calls":[{"name":"missing","arguments":{}}]}',
    tools,
    "seed",
  ), undefined);
  assert.equal(parseControlledToolEnvelope(
    '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":[]}]}',
    tools,
    "seed",
  ), undefined);
});

test("structured tool calls fail closed and unsafe IDs are regenerated", () => {
  assert.throws(
    () => normaliseAssistantToolCalls({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_valid", type: "function", function: { name: "calculator", arguments: '{"a":1,"b":2}' } },
        { id: "call_invalid", type: "function", function: { name: "missing", arguments: "{}" } },
      ],
    }, tools, "seed"),
    InvalidStructuredToolCallsError,
  );

  const normalized = normaliseAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "x".repeat(10_000), type: "function", function: { name: "calculator", arguments: '{"a":1,"b":2}' } }],
  }, tools, "chatcmpl-long-id");
  assert.match(normalized.tool_calls?.[0]?.id ?? "", /^call_[A-Za-z0-9]+_1$/);
  assert.ok((normalized.tool_calls?.[0]?.id.length ?? 0) <= 128);
});

test("required and forced tool choices reject a final envelope", () => {
  const finalEnvelope = parseControlledToolEnvelope('{"type":"final","content":"done"}', tools, "seed");
  assert.equal(envelopeAllowedForToolChoice(finalEnvelope, "auto"), true);
  assert.equal(envelopeAllowedForToolChoice(finalEnvelope, "required"), false);
  assert.equal(envelopeAllowedForToolChoice(finalEnvelope, { type: "function", function: { name: "calculator" } }), false);
});

test("Ajv applies nested refs and nontrivial JSON Schema constraints", () => {
  const schema = {
    type: "object",
    minProperties: 2,
    properties: {
      score: { $ref: "#/$defs/score" },
      labels: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string" } },
    },
    required: ["score", "labels"],
    additionalProperties: false,
    $defs: {
      score: { type: "number", exclusiveMinimum: 0, multipleOf: 0.5 },
    },
  };

  assert.deepEqual(validateSchemaDefinition(schema), { valid: true, errors: [] });
  assert.equal(validateJsonSchema({ score: 1.5, labels: ["a", "b"] }, schema).valid, true);
  const invalid = validateJsonSchema({ score: 0, labels: ["a", "a"] }, schema);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes("exclusiveMinimum")));
  assert.ok(invalid.errors.some((error) => error.includes("uniqueItems")));
});

test("repair reasoning is tagged for clients and stripped before upstream replay", () => {
  const tagged = tagRepairReasoning({ reasoning: "fix the JSON" });
  assert.equal(tagged.reasoning, `${REPAIR_REASONING_START}fix the JSON`);
  const streamed = [
    tagRepairReasoning({ reasoning: "fix " }, { start: true }).reasoning,
    tagRepairReasoning({ reasoning: "the JSON" }, { start: false }).reasoning,
  ].join("");
  assert.equal(streamed, `${REPAIR_REASONING_START}fix the JSON`);
  assert.equal(stripRepairReasoning(`first ${tagged.reasoning} second`), "first ");
  assert.equal(stripRepairReasoning("first @@REPAIR_REASONING@@unfinished"), "first ");

  const firstReasoning = "inspect package.json first";
  const clientVisibleReasoning = `${firstReasoning}${tagRepairReasoning({ reasoning: "repair the JSON" }).reasoning}`;
  assert.equal(stripRepairReasoning(clientVisibleReasoning), firstReasoning);
});

test("marked final replies are accepted and the marker is removed", () => {
  const parsed = parseControlledToolEnvelopeDetailed(
    `${FINAL_REPLY_MARKER}answer`,
    tools,
    "seed",
  );
  assert.deepEqual(parsed.envelope, { type: "final", content: "answer" });
});

test("controlled envelope reports exact JSON and call-shape errors for repair", () => {
  const malformed = parseControlledToolEnvelopeDetailed(
    '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":{"a":1,"b":2}}]',
    tools,
    "seed",
  );
  assert.equal(malformed.envelope, undefined);
  assert.match(malformed.error ?? "", /^JSON parse failed:/);

  const badArguments = parseControlledToolEnvelopeDetailed(
    '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":[]}]}',
    tools,
    "seed",
  );
  assert.equal(badArguments.envelope, undefined);
  assert.match(badArguments.error ?? "", /tool_calls\[0\]/);
});

test("controlled envelope leaves embedded or bare call forms to the repair loop", () => {
  const embedded = parseControlledToolEnvelopeDetailed(
    'Thought complete. <tool_call>{"name":"calculator","arguments":{"a":1,"b":2}}</tool_call>',
    tools,
    "seed",
  );
  assert.equal(embedded.envelope, undefined);
  assert.match(embedded.error ?? "", /^JSON parse failed:/);

  const bare = parseControlledToolEnvelopeDetailed(
    '{"name":"calculator","arguments":{"a":1,"b":2}}',
    tools,
    "seed",
  );
  assert.equal(bare.envelope, undefined);
  assert.match(bare.error ?? "", /envelope `type`/);
});

test("repair history replaces the failed candidate and retains initial reasoning", () => {
  const original = [{ role: "user" as const, content: "read package.json" }];
  const first = buildToolRepairHistory(
    original,
    {
      role: "assistant",
      content: '{"type":"tool_calls","tool_calls":[{"name":"read","arguments":{path:"package.json"}}]}',
      reasoning: "thinking 1",
    },
    { role: "user", content: "JSON parse failed: Unexpected token p" },
  );
  const second = buildToolRepairHistory(
    original,
    {
      role: "assistant",
      content: '{"type":"tool_calls","tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]',
      reasoning: "thinking 1",
    },
    { role: "user", content: "JSON parse failed: Unexpected end of JSON input" },
  );

  assert.deepEqual(first.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(second.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(second[1]?.reasoning, "thinking 1");
  assert.equal(second[1]?.content, '{"type":"tool_calls","tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]');
  assert.match(String(second[2]?.content), /Unexpected end of JSON input/);
});

test("adapter contract follows caller instructions and the latest tool result", () => {
  const messages = [
    { role: "system" as const, content: "caller tool syntax" },
    { role: "developer" as const, content: "more caller instructions" },
    { role: "user" as const, content: "read package.json" },
    { role: "assistant" as const, content: null, tool_calls: [{
      id: "call_1",
      type: "function" as const,
      function: { name: "calculator", arguments: '{"a":1,"b":2}' },
    }] },
    { role: "tool" as const, tool_call_id: "call_1", content: "3" },
  ];
  const contracted = withToolCallContract(messages, tools, "required", false);
  assert.deepEqual(contracted.map((message) => message.role), [
    "system", "developer", "user", "assistant", "tool", "system",
  ]);
  assert.equal(contracted[0]?.content, "caller tool syntax");
  assert.match(String(contracted.at(-1)?.content), /IMPORTANT ADAPTER OVERRIDE/);
  assert.match(String(contracted.at(-1)?.content), /Never use a native or hidden tool channel/);
  assert.match(String(contracted.at(-1)?.content), /"properties":\{"a"/);
  assert.doesNotMatch(String(contracted.at(-1)?.content), /caller tool syntax/);
});

test("adapter contract can be re-applied after a repair candidate", () => {
  const history = [
    { role: "user" as const, content: "edit package.json" },
    { role: "assistant" as const, content: "not-json" },
    { role: "user" as const, content: "JSON parse failed; retry" },
  ];
  const contracted = withToolCallContract(history, tools, "required", true);
  assert.equal(contracted.at(-1)?.role, "system");
  assert.match(String(contracted.at(-1)?.content), /IMPORTANT ADAPTER OVERRIDE/);
  assert.equal(contracted.at(-2)?.content, "JSON parse failed; retry");
});

test("adapter contract moves an existing copy back to the absolute tail", () => {
  const first = withToolCallContract([{ role: "user", content: "edit" }], tools, "required");
  const withLaterHistory = [
    ...first,
    { role: "tool" as const, tool_call_id: "call_1", content: "done" },
  ];
  const contracted = withToolCallContract(withLaterHistory, tools, "required");
  assert.equal(contracted.at(-1)?.role, "system");
  assert.equal(contracted.filter((message) => message.role === "system").length, 1);
  assert.equal(contracted.at(-2)?.role, "tool");
});

test("compact tool contracts preserve schema property names and references", () => {
  const referencedTools = [{
    type: "function" as const,
    function: {
      name: "write_file",
      parameters: {
        type: "object",
        properties: { payload: { $ref: "#/$defs/payload" } },
        required: ["payload"],
        additionalProperties: false,
        $defs: { payload: { type: "string", minLength: 1 } },
      },
    },
  }];
  const contract = withToolCallContract([{ role: "user", content: "write" }], referencedTools, "required");
  const text = String(contract.at(-1)?.content);
  assert.match(text, /"payload"/);
  assert.match(text, /#\/\$defs\/payload/);
  assert.match(text, /"\$defs"/);
});

test("tool contracts preserve descriptions and every JSON Schema constraint", () => {
  const constrained = [{
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write exactly one UTF-8 file.",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number", multipleOf: 0.25 },
        },
        dependentRequired: { value: ["value"] },
        required: ["value"],
      },
    },
  }];
  const text = String(withToolCallContract([{ role: "user", content: "write" }], constrained, "required").at(-1)?.content);
  assert.match(text, /Write exactly one UTF-8 file/);
  assert.match(text, /"multipleOf":0\.25/);
  assert.match(text, /"dependentRequired"/);
});

test("debug redaction covers camelCase credential fields", () => {
  const redacted = redact({ accessToken: "a", sessionCookie: "b", csrfToken: "c", clientSecret: "d", safeValue: "ok" });
  assert.deepEqual(redacted, {
    accessToken: "[redacted]",
    sessionCookie: "[redacted]",
    csrfToken: "[redacted]",
    clientSecret: "[redacted]",
    safeValue: "ok",
  });
});

test("tool schemas support explicit Draft 7 and 2020-12 dialects", () => {
  const draft7 = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { value: { type: "integer", minimum: 1 } },
    required: ["value"],
    additionalProperties: false,
  };
  const draft2020 = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "array",
    prefixItems: [{ const: "tool" }, { type: "integer" }],
    items: false,
  };

  assert.equal(validateSchemaDefinition(draft7).valid, true);
  assert.equal(validateJsonSchema({ value: 2 }, draft7).valid, true);
  assert.equal(validateSchemaDefinition(draft2020).valid, true);
  assert.equal(validateJsonSchema(["tool", 2], draft2020).valid, true);
  assert.equal(validateJsonSchema(["tool", "bad"], draft2020).valid, false);
});

test("invalid schemas and malformed argument JSON fail before execution", () => {
  assert.equal(validateSchemaDefinition({ $ref: "#/missing" }).valid, false);
  assert.equal(parseAndValidateToolArguments("not-json", tools[0].function.parameters).validation.valid, false);
  assert.equal(parseAndValidateToolArguments("[]", tools[0].function.parameters).validation.valid, false);
});

test("compiled JSON Schema caches stay bounded", () => {
  for (let index = 0; index < 700; index += 1) {
    assert.equal(validateSchemaDefinition({ type: "integer", minimum: index }).valid, true);
  }
  const stats = jsonSchemaCacheStats();
  assert.ok(stats.compiledSchemas <= 500);
  if (stats.ajvSchemas !== null) {
    assert.ok(stats.ajvSchemas <= stats.compiledSchemas + 32);
  }
});

test("fragmented upstream SSE is assembled without losing deltas", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","model":"kimi-k3","choices":[{"delta":{"role":"assistant","content":"hel"},"finish_reason":null}]}\n'));
      controller.enqueue(encoder.encode('\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  const forwarded: string[] = [];
  const collected = await collectUpstreamStream(new Response(stream), (frame) => {
    const content = frame.choices?.[0]?.delta?.content;
    if (typeof content === "string") forwarded.push(content);
  });

  assert.equal(collected.frames.length, 3);
  assert.match(collected.raw, /"content":"hel"/);
  assert.match(collected.raw, /data: \[DONE\]/);
  assert.deepEqual(forwarded, ["hel", "lo"]);
  assert.equal(collected.completion.choices?.[0]?.message?.content, "hello");
  assert.equal(collected.completion.choices?.[0]?.finish_reason, "stop");
  assert.equal(collected.completion.usage?.total_tokens, 5);
});

test("streaming SSE writes its first event before the producer finishes", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const response = openAIStreamingSse(async (emit) => {
    await emit({ data: { delta: "first" } });
    await gate;
    await emit({ data: { delta: "second" } });
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(decoder.decode(first.value), /"first"/);

  release();
  let rest = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    rest += decoder.decode(next.value, { stream: true });
  }
  assert.match(rest, /"second"/);
  assert.match(rest, /data: \[DONE\]/);
});

test("streaming SSE aborts its producer when the client cancels", async () => {
  let resolveAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => { resolveAbort = resolve; });
  const response = openAIStreamingSse(async (emit, signal) => {
    await emit({ data: { delta: "first" } });
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolveAbort();
        resolve();
        return;
      }
      signal.addEventListener("abort", () => {
        resolveAbort();
        resolve();
      }, { once: true });
    });
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  await reader.cancel();
  await Promise.race([
    aborted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort was not observed")), 100)),
  ]);
});

test("upstream reasoning summaries stay distinct from raw reasoning content", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","model":"kimi-k3","choices":[{"delta":{"role":"assistant","reasoning":"public summary"},"finish_reason":null}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"private trace","content":"answer"},"finish_reason":"stop"}]}\n\n'));
      controller.close();
    },
  });
  const collected = await collectUpstreamStream(new Response(stream));
  const message = collected.completion.choices?.[0]?.message;

  assert.equal(message?.reasoning, "public summary");
  assert.equal(message?.reasoning_content, "private trace");
  assert.equal(message?.content, "answer");
});

test("upstream SSE error and empty streams fail closed", async () => {
  await assert.rejects(
    collectUpstreamStream(new Response('data: {"error":{"message":"unknown model"}}\n\n')),
    (error: unknown) => error instanceof UpstreamStreamError
      && error.status === 502
      && error.message === "unknown model"
      && error.rawResponse?.includes('"unknown model"') === true,
  );
  await assert.rejects(
    collectUpstreamStream(new Response('data: {"error":"Gateway returned status 404","status":404}\n\n')),
    (error: unknown) => error instanceof UpstreamStreamError && error.status === 404,
  );
  await assert.rejects(
    collectUpstreamStream(new Response("data: [DONE]\n\n")),
    /no data frames/,
  );
  await assert.rejects(
    collectUpstreamStream(new Response('data: {"choices":]\n\n')),
    /invalid JSON data/,
  );
});


test("Chat and Responses SSE use their respective termination contracts", async () => {
  const chat = await openAISse([{ data: { id: "chatcmpl-1" } }]).text();
  const responses = await openAISse(
    [{ event: "response.completed", data: { type: "response.completed" } }],
    { doneMarker: false },
  ).text();

  assert.match(chat, /data: \[DONE\]/);
  assert.doesNotMatch(responses, /\[DONE\]/);
  assert.match(responses, /^event: response\.completed/m);
});

test("Responses text events carry item IDs, annotations, and incomplete status", () => {
  const response = {
    id: "resp_test",
    object: "response",
    status: "incomplete",
    output_text: "partial",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{
      id: "msg_test",
      type: "message",
      status: "incomplete",
      role: "assistant",
      content: [{ type: "output_text", text: "partial", annotations: [] }],
    }],
  };
  const events = responsesStreamEvents(response);
  const byName = new Map(events.map((event) => [event.event, event.data]));

  assert.deepEqual((byName.get("response.created")?.response as Record<string, unknown>).output, []);
  assert.equal(events[1]?.event, "response.in_progress");
  assert.equal((events[1]?.data.response as Record<string, unknown>).status, "in_progress");
  assert.equal(byName.get("response.output_text.delta")?.item_id, "msg_test");
  assert.equal(byName.get("response.output_text.done")?.item_id, "msg_test");
  assert.deepEqual(byName.get("response.output_text.delta")?.logprobs, []);
  assert.deepEqual(byName.get("response.output_text.done")?.logprobs, []);
  assert.deepEqual((byName.get("response.content_part.added")?.part as Record<string, unknown>).annotations, []);
  assert.deepEqual((byName.get("response.content_part.done")?.part as Record<string, unknown>).annotations, []);
  assert.deepEqual((byName.get("response.content_part.done")?.part as Record<string, unknown>).logprobs, []);
  assert.equal(events.at(-1)?.event, "response.incomplete");
  assert.equal(events.at(-1)?.data.type, "response.incomplete");
});

test("Responses reasoning summaries have their own lifecycle events", () => {
  const events = responsesStreamEvents({
    id: "resp_reasoning",
    object: "response",
    status: "completed",
    output: [{
      id: "rs_test",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "public summary" }],
    }],
  });
  const byName = new Map(events.map((event) => [event.event, event.data]));

  assert.equal((byName.get("response.output_item.added")?.item as Record<string, unknown>).type, "reasoning");
  assert.equal((byName.get("response.output_item.added")?.item as Record<string, unknown>).status, "in_progress");
  assert.deepEqual((byName.get("response.output_item.added")?.item as Record<string, unknown>).summary, []);
  assert.equal(byName.get("response.reasoning_summary_text.delta")?.delta, "public summary");
  assert.equal(byName.get("response.reasoning_summary_text.done")?.text, "public summary");
  assert.equal(events.at(-1)?.event, "response.completed");
});

test("Responses refusals use refusal events instead of output text events", () => {
  const events = responsesStreamEvents({
    id: "resp_refusal",
    object: "response",
    status: "completed",
    output: [{
      id: "msg_refusal",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "refusal", refusal: "cannot comply" }],
    }],
  });
  assert.ok(events.some((event) => event.event === "response.refusal.delta"));
  assert.ok(events.some((event) => event.event === "response.refusal.done"));
  assert.ok(!events.some((event) => event.event === "response.output_text.done"));
});

test("Responses metadata and usage satisfy strict SDK-required fields", () => {
  assert.deepEqual(responseCompatibilityFields({ parallel_tool_calls: false }, tools), {
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [{
      type: "function",
      name: "calculator",
      parameters: tools[0]!.function.parameters,
    }],
  });
  assert.deepEqual(responseCompatibilityFields({
    tool_choice: { type: "function", name: "calculator" },
  }, tools).tool_choice, { type: "function", name: "calculator" });
  assert.deepEqual(responseUsage(undefined), {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  });
  assert.deepEqual(responseUsage({
    prompt_tokens: 8,
    completion_tokens: 5,
    total_tokens: 13,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 2 },
  }), {
    input_tokens: 8,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 13,
  });
  const envelope = responseEnvelopeFields(
    { instructions: "developer context", store: false },
    [],
    undefined,
    "completed",
    1_700_000_000,
  );
  for (const field of [
    "error",
    "incomplete_details",
    "instructions",
    "metadata",
    "temperature",
    "top_p",
    "parallel_tool_calls",
    "tool_choice",
    "tools",
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(envelope, field), `missing response field ${field}`);
  }
  assert.equal(envelope.error, null);
  assert.equal(envelope.incomplete_details, null);
  assert.equal(envelope.store, false);
});
