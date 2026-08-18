import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidStructuredToolCallsError,
  envelopeAllowedForToolChoice,
  normaliseAssistantToolCalls,
  parseControlledToolEnvelope,
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
  openAISse,
} from "../server/utils/upstream-stream.ts";

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
    assert.ok(stats.ajvSchemas <= 501);
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
  const collected = await collectUpstreamStream(new Response(stream));

  assert.equal(collected.frames.length, 3);
  assert.equal(collected.completion.choices?.[0]?.message?.content, "hello");
  assert.equal(collected.completion.choices?.[0]?.finish_reason, "stop");
  assert.equal(collected.completion.usage?.total_tokens, 5);
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
    /unknown model/,
  );
  await assert.rejects(
    collectUpstreamStream(new Response("data: [DONE]\n\n")),
    /no data frames/,
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
