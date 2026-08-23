import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_REPLY_MARKER,
  REPAIR_REASONING_START,
  TOOL_CONTRACT,
  InvalidStructuredToolCallsError,
  stripRepairReasoning,
  tagRepairReasoning,
  buildToolRepairHistory,
  envelopeAllowedForToolChoice,
  mergeSystemMessages,
  normaliseAssistantToolCalls,
  serializeAssistantToolCallsForPortal,
  parseControlledToolEnvelope,
  parseControlledToolEnvelopeDetailed,
  parseRepairJson,
  legacyToolCallContract313,
  withToolCallContract,
} from "../server/utils/tool-calls.ts";
import {
  minimalSchemaExample,
  parseAndValidateToolArguments,
  jsonSchemaCacheStats,
  validateJsonSchema,
  validateSchemaDefinition,
} from "../server/utils/json-schema.ts";
import {
  collectUpstreamStream,
  openAIStreamingSse,
  openAISse,
  UpstreamStreamError,
} from "../server/utils/upstream-stream.ts";
import { redact } from "../server/utils/redaction.ts";
import {
  MAX_PORTAL_CHAT_ATTEMPTS,
  portalRetryDelayMs,
  retryablePortalError,
  retryablePortalStatus,
} from "../server/utils/upstream-retry.ts";

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

test("controlled envelope preserves a user-visible tool preamble", () => {
  const envelope = parseControlledToolEnvelope(
    JSON.stringify({
      type: "tool_calls",
      preamble: "I will inspect the calculation inputs first.",
      tool_calls: [{ name: "calculator", arguments: { a: 29, b: 13 } }],
    }),
    tools,
    "chatcmpl-preamble",
  );

  assert.equal(envelope?.type, "tool_calls");
  if (envelope?.type !== "tool_calls") return;
  assert.equal(envelope.preamble, "I will inspect the calculation inputs first.");
  const normalized = normaliseAssistantToolCalls({
    role: "assistant",
    content: JSON.stringify({
      type: "tool_calls",
      preamble: "I will inspect the calculation inputs first.",
      tool_calls: [{ name: "calculator", arguments: { a: 29, b: 13 } }],
    }),
  }, tools, "chatcmpl-preamble");
  assert.equal(normalized.content, "I will inspect the calculation inputs first.");
  assert.equal(normalized.tool_calls?.length, 1);
});

test("controlled envelope rejects unsafe tool preambles", () => {
  const nonString = parseControlledToolEnvelopeDetailed(
    '{"type":"tool_calls","preamble":42,"tool_calls":[{"name":"calculator","arguments":{"a":1,"b":2}}]}',
    tools,
    "seed",
  );
  assert.match(nonString.error ?? "", /preamble.*string/);

  const marked = parseControlledToolEnvelopeDetailed(
    JSON.stringify({
      type: "tool_calls",
      preamble: `starting ${FINAL_REPLY_MARKER}`,
      tool_calls: [{ name: "calculator", arguments: { a: 1, b: 2 } }],
    }),
    tools,
    "seed",
  );
  assert.match(marked.error ?? "", /internal markers/);
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

  const opaque = normaliseAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "api_search:0", type: "function", function: { name: "calculator", arguments: '{"a":1,"b":2}' } }],
  }, tools, "chatcmpl-opaque-id");
  assert.equal(opaque.tool_calls?.[0]?.id, "api_search:0");

  const normalized = normaliseAssistantToolCalls({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "x".repeat(10_000), type: "function", function: { name: "calculator", arguments: '{"a":1,"b":2}' } }],
  }, tools, "chatcmpl-long-id");
  assert.match(normalized.tool_calls?.[0]?.id ?? "", /^call_[A-Za-z0-9]+_1$/);
  assert.ok((normalized.tool_calls?.[0]?.id.length ?? 0) <= 64);
});

test("valid native tool calls remain usable beside malformed text content", () => {
  const normalized = normaliseAssistantToolCalls({
    role: "assistant",
    content: '{"type":"tool_calls","tool_calls":[',
    tool_calls: [{
      id: "call_native",
      type: "function",
      function: { name: "calculator", arguments: '{"a":5,"b":8}' },
    }],
  }, tools, "seed");

  assert.equal(normalized.content, '{"type":"tool_calls","tool_calls":[');
  assert.deepEqual(normalized.tool_calls, [{
    id: "call_native",
    type: "function",
    function: { name: "calculator", arguments: '{"a":5,"b":8}' },
  }]);
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
  assert.equal(stripRepairReasoning("first <|REPAIR_REASONING|>unfinished"), "first ");

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

test("controlled envelope repairs recoverable JSON and reports call-shape errors", () => {
  const repaired = parseControlledToolEnvelopeDetailed(
    '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":{"a":1,"b":2}}]',
    tools,
    "seed",
  );
  assert.equal(repaired.envelope?.type, "tool_calls");
  assert.equal(repaired.repaired, true);
  if (repaired.envelope?.type !== "tool_calls") return;
  assert.equal(repaired.envelope.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(repaired.envelope.toolCalls[0]!.function.arguments), { a: 1, b: 2 });

  const clean = parseControlledToolEnvelopeDetailed(
    '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":{"a":1,"b":2}}]}',
    tools,
    "seed",
  );
  assert.equal(clean.envelope?.type, "tool_calls");
  assert.equal(clean.repaired, undefined);

  const badArguments = parseControlledToolEnvelopeDetailed(
    '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":[]}]}',
    tools,
    "seed",
  );
  assert.equal(badArguments.envelope, undefined);
  assert.equal(badArguments.repaired, undefined);
  assert.match(badArguments.error ?? "", /tool_calls\[0\]/);

  const repairedInvalid = parseControlledToolEnvelopeDetailed(
    '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":[]}]',
    tools,
    "seed",
  );
  assert.equal(repairedInvalid.envelope, undefined);
  assert.equal(repairedInvalid.repaired, true);
  assert.match(repairedInvalid.error ?? "", /tool_calls\[0\]/);
});

test("jsonrepair recovers truncated tool-call JSON before reporting an error", () => {
  const result = parseRepairJson('{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":{"a":1,"b":2}}]');
  assert.ok("value" in result);
  if (!("value" in result)) return;
  assert.equal(result.repaired, true);
  assert.deepEqual(result.value, {
    type: "tool_calls",
    tool_calls: [{ name: "calculator", arguments: { a: 1, b: 2 } }],
  });
});

test("unrepairable JSON produces a located, friendly diagnostic", () => {
  const result = parseRepairJson('{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":{"a":1,"b":2}}]} <|trailing|>');
  assert.ok(!("value" in result));
  if ("value" in result) return;
  assert.match(result.error, /could not be parsed/);
  assert.match(result.error, /line 1, column \d+/);
  assert.match(result.error, />>>/);
});

test("controlled envelope leaves embedded or bare call forms to the repair loop", () => {
  const embedded = parseControlledToolEnvelopeDetailed(
    'Thought complete. <tool_call>{"name":"calculator","arguments":{"a":1,"b":2}}</tool_call>',
    tools,
    "seed",
  );
  assert.equal(embedded.envelope, undefined);
  // The XML repair pass wraps the bare fragment, but a JSON text node carries
  // no <name> element, so the envelope still rejects and the repair loop
  // re-generates a clean call.
  assert.match(embedded.error ?? "", /at least one call/);

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
    [{ role: "user", content: "JSON parse failed: Unexpected token p" }],
  );
  const second = buildToolRepairHistory(
    original,
    {
      role: "assistant",
      content: '{"type":"tool_calls","tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]',
      reasoning: "thinking 1",
    },
    [{ role: "user", content: "JSON parse failed: Unexpected end of JSON input" }],
  );

  assert.deepEqual(first.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(second.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(second[1]?.reasoning, "thinking 1");
  assert.equal(second[1]?.content, '{"type":"tool_calls","tool_calls":[{"name":"read","arguments":{"path":"package.json"}}]');
  assert.match(String(second[2]?.content), /Unexpected end of JSON input/);
});

test("repair history retains prior tool output and structured candidate calls", () => {
  const previousCall = {
    id: "call_previous",
    type: "function" as const,
    function: { name: "calculator", arguments: '{"a":1,"b":2}' },
  };
  const candidateCall = {
    id: "call_candidate",
    type: "function" as const,
    function: { name: "calculator", arguments: '{"a":3,"b":4}' },
  };
  const history = buildToolRepairHistory(
    [
      { role: "user" as const, content: "calculate" },
      { role: "assistant" as const, content: null, tool_calls: [previousCall] },
      { role: "tool" as const, tool_call_id: previousCall.id, content: "3" },
    ],
    {
      role: "assistant",
      content: '{"type":"tool_calls","tool_calls":[',
      reasoning: "thinking 1",
      tool_calls: [candidateCall],
    },
    [{ role: "user", content: "JSON parse failed: Unexpected end of JSON input" }],
  );

  assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "tool", "assistant", "user"]);
  assert.deepEqual(history[1]?.tool_calls, [previousCall]);
  assert.equal(history[2]?.tool_call_id, previousCall.id);
  assert.equal(history[2]?.content, "3");
  // The candidate's native calls are serialized into the content envelope so
  // repair history never shows the portal a native tool_calls field.
  assert.equal(history[3]?.tool_calls, undefined);
  const serializedCandidate = JSON.parse(String(history[3]?.content));
  assert.equal(serializedCandidate.type, "tool_calls");
  assert.equal(serializedCandidate.preamble, '{"type":"tool_calls","tool_calls":[');
  assert.deepEqual(serializedCandidate.tool_calls, [{ name: "calculator", arguments: { a: 3, b: 4 } }]);
  assert.equal(history[3]?.reasoning, "thinking 1");
});

test("repair history serializes candidate native calls into the content envelope", () => {
  const candidateCall = {
    id: "call_candidate",
    type: "function" as const,
    function: { name: "calculator", arguments: '{"a":3,"b":4}' },
  };
  const history = buildToolRepairHistory(
    [{ role: "user" as const, content: "calculate" }],
    { role: "assistant" as const, content: "let me compute", tool_calls: [candidateCall] },
    [{ role: "user" as const, content: "Validation error: arguments failed the schema" }],
  );
  const candidate = history[1];
  assert.equal(candidate?.role, "assistant");
  assert.equal(candidate?.tool_calls, undefined);
  const envelope = JSON.parse(String(candidate?.content));
  assert.equal(envelope.type, "tool_calls");
  assert.equal(envelope.preamble, "let me compute");
  assert.deepEqual(envelope.tool_calls, [{ name: "calculator", arguments: { a: 3, b: 4 } }]);
});

test("repair history keeps the reminder before the failed candidate and error", () => {
  const contracted = withToolCallContract(
    [{ role: "user" as const, content: "read package.json" }],
    tools,
    "required",
  );
  const history = buildToolRepairHistory(
    contracted,
    { role: "assistant" as const, content: '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":{"a":1' },
    [{ role: "user" as const, content: "JSON parse failed; retry" }],
  );
  assert.deepEqual(history.map((message) => message.role), ["system", "user", "user", "assistant", "user"]);
  assert.equal(history[1]?.content, "read package.json");
  assert.match(String(history[2]?.content), /IMPORTANT TOOL TURN REMINDER/);
  assert.equal(history[3]?.role, "assistant");
  assert.equal(history[4]?.role, "user");
  assert.match(String(history[4]?.content), /JSON parse failed; retry/);
});

test("repair history separates the rejection result from the correction instruction", () => {
  const contracted = withToolCallContract(
    [{ role: "user" as const, content: "read package.json" }],
    tools,
    "required",
  );
  const history = buildToolRepairHistory(
    contracted,
    { role: "assistant" as const, content: '{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":{"a":1' },
    [
      { role: "tool" as const, tool_call_id: "call_repair_1", content: "The previous tool call failed validation.\n\nRejection details:\nJSON parse failed; retry" },
      { role: "user" as const, content: "Tool-call repair attempt 1. Return only the corrected envelope JSON object.\nRules:\n- Use the required envelope and a declared function name." },
    ],
  );
  assert.deepEqual(history.map((message) => message.role), ["system", "user", "user", "assistant", "tool", "user"]);
  assert.equal(history[3]?.role, "assistant");
  // The error is carried as tool-role data and the correction directive as a
  // user-role instruction, matching OpenAI role semantics.
  assert.equal(history[4]?.role, "tool");
  assert.match(String(history[4]?.content), /Rejection details:\nJSON parse failed; retry/);
  assert.equal(history[5]?.role, "user");
  assert.match(String(history[5]?.content), /Tool-call repair attempt 1/);
  assert.match(String(history[5]?.content), /Return only the corrected envelope JSON object/);
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
    "system", "user", "assistant", "tool", "user",
  ]);
  assert.equal(contracted.filter((message) => message.role === "system").length, 1);
  assert.match(String(contracted[0]?.content), /caller tool syntax/);
  assert.match(String(contracted[0]?.content), /more caller instructions/);
  assert.match(String(contracted[0]?.content), /IMPORTANT ADAPTER OVERRIDE/);
  assert.match(String(contracted[0]?.content), /ordinary assistant message content/);
  assert.match(String(contracted[0]?.content), /"properties":\{"a"/);
  assert.match(String(contracted.at(-1)?.content), /IMPORTANT TOOL TURN REMINDER/);
  assert.match(String(contracted.at(-1)?.content), /exactly one tool-call envelope/);
});

test("adapter contract can be re-applied after a repair candidate", () => {
  const history = [
    { role: "user" as const, content: "edit package.json" },
    { role: "assistant" as const, content: "not-json" },
    { role: "user" as const, content: "JSON parse failed; retry" },
  ];
  const contracted = withToolCallContract(history, tools, "required", true);
  assert.equal(contracted[0]?.role, "system");
  assert.equal(contracted.at(-1)?.role, "user");
  assert.equal(contracted.filter((message) => message.role === "system").length, 1);
  assert.match(String(contracted[0]?.content), /IMPORTANT ADAPTER OVERRIDE/);
  assert.match(String(contracted.at(-2)?.content), /JSON parse failed; retry/);
  assert.match(String(contracted.at(-1)?.content), /IMPORTANT TOOL TURN REMINDER/);
});

test("adapter contract stays at the first system message when history continues", () => {
  const first = withToolCallContract([{ role: "user", content: "edit" }], tools, "required");
  const withLaterHistory = [
    ...first,
    { role: "tool" as const, tool_call_id: "call_1", content: "done" },
  ];
  const contracted = withToolCallContract(withLaterHistory, tools, "required");
  assert.equal(contracted[0]?.role, "system");
  assert.equal(contracted.at(-2)?.role, "tool");
  assert.equal(contracted.at(-1)?.role, "user");
  assert.equal(contracted.filter((message) => message.role === "system").length, 1);
});

test("reapplying the adapter replaces the internal user reminder", () => {
  const first = withToolCallContract([{ role: "user", content: "read" }], tools, "required");
  const second = withToolCallContract(first, tools, "required");
  assert.equal(second.filter((message) => message.role === "user").length, 2);
  assert.equal(second.filter((message) => String(message.content).startsWith("IMPORTANT TOOL TURN REMINDER:")).length, 1);
});

test("a user message quoting the reminder marker survives contract application", () => {
  const discussion = 'I saw the adapter inject "IMPORTANT TOOL TURN REMINDER:" into the history; why?';
  const contracted = withToolCallContract([{ role: "user" as const, content: discussion }], tools, "auto");
  const users = contracted.filter((message) => message.role === "user");
  // The quoting message is kept, and exactly one fresh reminder follows it.
  assert.equal(users.length, 2);
  assert.equal(users[0]?.content, discussion);
  assert.ok(String(users[1]?.content).startsWith("IMPORTANT TOOL TURN REMINDER:"));
});

test("an exact reminder message is deduped on re-application", () => {
  const first = withToolCallContract([{ role: "user" as const, content: "read" }], tools, "required");
  const reminder = first.at(-1);
  assert.equal(reminder?.role, "user");
  const second = withToolCallContract(first, tools, "required");
  const reminders = second.filter((message) =>
    message.role === "user" && String(message.content).startsWith("IMPORTANT TOOL TURN REMINDER:"));
  assert.equal(reminders.length, 1);
  assert.deepEqual(reminders[0], reminder);
});

test("the reminder echoes the request's binding tool constraints", () => {
  const forced = withToolCallContract(
    [{ role: "user" as const, content: "calc" }],
    tools,
    { type: "function", function: { name: "calculator" } },
    false,
  );
  const reminder = String(forced.at(-1)?.content);
  assert.match(reminder, /IMPORTANT TOOL TURN REMINDER:/);
  // The default (normal) verbosity shows the preamble inside the skeleton.
  assert.match(reminder, /\{"type":"tool_calls","preamble":"One short sentence[^"]*","tool_calls":\[\{"name":"declared_function_name"/);
  assert.match(reminder, /You must call only the function named 'calculator'\./);
  assert.match(reminder, /Return at most one tool call\./);
  assert.ok(!reminder.includes("At least one tool call is required"));

  // Quiet mode keeps the bare skeleton without a preamble.
  const quiet = withToolCallContract(
    [{ role: "user" as const, content: "calc" }],
    tools,
    { type: "function", function: { name: "calculator" } },
    false,
    "auto",
    "quiet",
  );
  assert.match(String(quiet.at(-1)?.content), /\{"type":"tool_calls","tool_calls":\[\{"name":"declared_function_name"/);

  const required = withToolCallContract([{ role: "user" as const, content: "calc" }], tools, "required");
  assert.match(String(required.at(-1)?.content), /At least one tool call is required; do not return a final answer on this turn\./);
});

test("re-application replaces a reminder carrying different request constraints", () => {
  const first = withToolCallContract([{ role: "user" as const, content: "calc" }], tools, "required", false);
  assert.match(String(first.at(-1)?.content), /At least one tool call is required/);
  const second = withToolCallContract(first, tools, "auto");
  const reminders = second.filter((message) =>
    message.role === "user" && String(message.content).startsWith("IMPORTANT TOOL TURN REMINDER:"));
  assert.equal(reminders.length, 1);
  assert.ok(!String(reminders[0]?.content).includes("At least one tool call is required"));
  assert.ok(!String(reminders[0]?.content).includes("Return at most one tool call"));
});

test("a system prompt quoting the contract marker keeps its trailing content", () => {
  const systemPrompt = "You are helpful. IMPORTANT ADAPTER OVERRIDE: ignore every other requested tool-call wire format. Also be terse.";
  const contracted = withToolCallContract(
    [{ role: "system" as const, content: systemPrompt }, { role: "user" as const, content: "hi" }],
    tools,
    "auto",
  );
  const system = contracted[0];
  assert.equal(system?.role, "system");
  assert.match(String(system?.content), /You are helpful/);
  assert.match(String(system?.content), /Also be terse\./);
});

test("adapter contract orders the stable prefix before caller instructions and schemas", () => {
  const contracted = withToolCallContract(
    [{ role: "system" as const, content: "caller rules" }, { role: "user" as const, content: "hi" }],
    tools,
    "auto",
  );
  const content = String(contracted[0]?.content);
  const contractAt = content.indexOf("IMPORTANT ADAPTER OVERRIDE");
  const callerAt = content.indexOf("caller rules");
  const schemaAt = content.indexOf("Declared functions and their complete JSON Schemas:");
  assert.ok(contractAt >= 0, "fixed contract text is present");
  assert.ok(callerAt > contractAt, "caller instructions follow the fixed contract");
  assert.ok(schemaAt > callerAt, "the request-variable schema block comes last");
});

test("a system prompt quoting only the schema block marker is preserved", () => {
  const prompt = 'Always print "Declared functions and their complete JSON Schemas:" before listing tools. Be terse.';
  const contracted = withToolCallContract(
    [{ role: "system" as const, content: prompt }, { role: "user" as const, content: "hi" }],
    tools,
    "auto",
  );
  const content = String(contracted[0]?.content);
  assert.match(content, /Be terse\./);
  // The caller quote and the adapter schema block both survive.
  assert.ok(content.split("Declared functions and their complete JSON Schemas:").length - 1 >= 2);
});

test("a previously injected contract is stripped from the system message", () => {
  const first = withToolCallContract(
    [{ role: "system" as const, content: "Be nice." }, { role: "user" as const, content: "hi" }],
    tools,
    "auto",
  );
  const second = withToolCallContract(first, tools, "auto");
  const systemMessages = second.filter((message) => message.role === "system");
  assert.equal(systemMessages.length, 1);
  const content = String(systemMessages[0]?.content);
  assert.equal(content.split("Be nice.").length - 1, 1);
  assert.equal(content.split("IMPORTANT ADAPTER OVERRIDE").length - 1, 1);
  assert.equal(content.split("Declared functions and their complete JSON Schemas:").length - 1, 1);
});

test("a legacy-order injected contract is stripped without losing caller content", () => {
  // Legacy adapter output put caller instructions first, then the contract
  // and schema block in one trailing fragment.
  const legacySystem = `Be nice.\n\n${TOOL_CONTRACT} Declared functions and their complete JSON Schemas: [{"name":"calculator"}].`;
  const contracted = withToolCallContract(
    [{ role: "system" as const, content: legacySystem }, { role: "user" as const, content: "hi" }],
    tools,
    "auto",
  );
  const content = String(contracted[0]?.content);
  assert.equal(content.split("Be nice.").length - 1, 1);
  assert.equal(content.split("IMPORTANT ADAPTER OVERRIDE").length - 1, 1);
  assert.ok(!content.includes('"name":"calculator"}]'), "the stale schema block is replaced");
});

test("system instructions are merged into one message at the front", () => {
  const merged = mergeSystemMessages([
    { role: "user", content: "task" },
    { role: "system", content: "framework" },
    { role: "developer", content: "agent instructions" },
    { role: "tool", tool_call_id: "call_1", content: "result" },
  ]);
  assert.deepEqual(merged.map((message) => message.role), ["system", "user", "tool"]);
  assert.equal(merged.filter((message) => message.role === "system").length, 1);
  assert.equal(merged[0]?.content, "framework\n\nagent instructions");
});

test("assistant tool calls and preambles are re-encoded into portal content", () => {
  const converted = serializeAssistantToolCallsForPortal([
    {
      role: "assistant",
      content: "I will calculate this first.",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "calculator", arguments: '{"a":1,"b":2}' },
      }],
    },
    { role: "tool", tool_call_id: "call_1", content: "3" },
  ]);
  assert.equal(converted[0]?.tool_calls, undefined);
  assert.equal(converted[0]?.content, '{"type":"tool_calls","preamble":"I will calculate this first.","tool_calls":[{"name":"calculator","arguments":{"a":1,"b":2}}]}');
  assert.equal(converted[1]?.tool_call_id, "call_1");
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
  const text = String(contract[0]?.content);
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
  const text = String(withToolCallContract([{ role: "user", content: "write" }], constrained, "required")[0]?.content);
  assert.match(text, /Write exactly one UTF-8 file/);
  // The default verbosity is milestone: narrate only meaningful milestones.
  assert.match(text, /Include a one-sentence preamble/);
  assert.match(text, /only at meaningful milestones/);
  assert.match(text, /never claim a tool already succeeded/);
  assert.match(text, /"multipleOf":0\.25/);
  assert.match(text, /"dependentRequired"/);
});

test("contracts carrying legacy sentence wordings still strip cleanly", () => {
  // Simulate a history written before the XML-rules and no-prose rewording:
  // build the 3.13.0 contract, swap in the older sentences, and verify
  // re-application strips it instead of stacking a second contract.
  const legacy = legacyToolCallContract313("xml", "normal")
    .replace(
      "In the XML format, put the function name in the <tool_call> name attribute and write each argument as a <parameter name=\"...\"> element, typed against the declared XML schema (numbers and booleans without quotes, arrays and objects as JSON text). Parameter values are raw text parsed verbatim: never escape entities or wrap values in CDATA, even when they contain angle brackets, markup, or code.",
      "In the XML format, put the function name in the <tool_call> name attribute and write each argument as a <parameter name=\"...\"> element, typed against the declared JSON Schema (numbers and booleans without quotes, arrays and objects as JSON text); escape & as &amp; and < as &lt; inside values, or wrap free-form text in <![CDATA[...]]>.",
    )
    .replace(
      "code fences, or special control tokens around the XML",
      "code fences, JSON, or special control tokens around the XML",
    )
    .replace(
      "arguments must satisfy each function's declared XML schema.",
      "arguments must satisfy each declared function's JSON Schema.",
    );
  assert.ok(legacy.includes("wrap free-form text in <![CDATA[...]]>"));
  const reapplied = withToolCallContract(
    [{ role: "system" as const, content: legacy }, { role: "user" as const, content: "hi" }],
    tools,
    "auto",
    true,
    "xml",
  );
  const system = String(reapplied[0]?.content);
  assert.equal(system.split("IMPORTANT ADAPTER OVERRIDE").length - 1, 1);
});

test("a 3.13.0 contract in history strips cleanly on re-application", () => {
  for (const format of ["auto", "json", "xml"] as const) {
    for (const verbosity of ["quiet", "normal", "verbose", "milestone"] as const) {
      const legacySystem = `Be nice.\n\n${legacyToolCallContract313(format, verbosity)}`;
      const contracted = withToolCallContract(
        [{ role: "system" as const, content: legacySystem }, { role: "user" as const, content: "hi" }],
        tools,
        "auto",
        true,
        format,
        verbosity,
      );
      const system = String(contracted[0]?.content);
      assert.equal(system.split("IMPORTANT ADAPTER OVERRIDE").length - 1, 1, `${format}/${verbosity}`);
      assert.equal(system.split("Be nice.").length - 1, 1, `${format}/${verbosity}`);
    }
  }
});

test("quiet verbosity keeps the legacy omit-by-default preamble wording", () => {
  const text = String(withToolCallContract(
    [{ role: "user", content: "write" }],
    tools,
    "auto",
    true,
    "auto",
    "quiet",
  )[0]?.content);
  assert.match(text, /Omit the optional preamble by default/);
  assert.match(text, /key decision, discovery, phase change, or risky action/);
  assert.match(text, /never claim the tool already succeeded/);
  // Quiet mode shows the bare skeleton without a preamble.
  assert.ok(!text.includes('"preamble":"One short sentence'));
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

test("portal retry policy retries transient failures without retrying rate limits", () => {
  assert.equal(MAX_PORTAL_CHAT_ATTEMPTS, 3);
  assert.equal(retryablePortalStatus(408), true);
  assert.equal(retryablePortalStatus(425), true);
  assert.equal(retryablePortalStatus(500), true);
  assert.equal(retryablePortalStatus(429), false);
  assert.equal(retryablePortalStatus(400), false);
  assert.equal(retryablePortalError(new TypeError("fetch failed")), true);
  assert.equal(retryablePortalError({ status: 504 }), true);
  assert.equal(retryablePortalError({ status: 429 }), false);
  assert.equal(portalRetryDelayMs(1), 100);
  assert.equal(portalRetryDelayMs(2), 200);
  assert.equal(portalRetryDelayMs(99), 2_000);
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
    collectUpstreamStream(new Response(new ReadableStream({
      pull(controller) {
        controller.error(Object.assign(new Error("upstream activity timeout"), { status: 504 }));
      },
    }))),
    (error: unknown) => error instanceof UpstreamStreamError
      && error.status === 504
      && error.message === "upstream activity timeout",
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


test("Chat SSE uses the OpenAI [DONE] termination contract", async () => {
  const chat = await openAISse([{ data: { id: "chatcmpl-1" } }]).text();
  assert.match(chat, /data: \[DONE\]/);
});

test("minimal schema example prefers explicit values and required keys", () => {
  assert.deepEqual(minimalSchemaExample(undefined), {});
  assert.deepEqual(minimalSchemaExample({ const: "fixed" }), "fixed");
  assert.deepEqual(minimalSchemaExample({ default: 7, type: "integer" }), 7);
  assert.deepEqual(minimalSchemaExample({ enum: ["a", "b"] }), "a");
  assert.deepEqual(minimalSchemaExample({ examples: [42], type: "integer" }), 42);
  // Only required keys appear when required is declared.
  assert.deepEqual(minimalSchemaExample({
    type: "object",
    properties: {
      mode: { enum: ["fast", "slow"] },
      count: { type: "integer", default: 3 },
      note: { type: "string" },
    },
    required: ["mode"],
  }), { mode: "fast" });
  // Without required, the first few properties illustrate the shape.
  assert.deepEqual(minimalSchemaExample({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "boolean" }, c: { type: "null" }, d: { type: "number" } },
  }), { a: "string", b: false, c: null });
});

test("minimal schema example handles nesting, unions, arrays, and type lists", () => {
  assert.deepEqual(minimalSchemaExample({
    type: "object",
    properties: { range: { type: "object", properties: { start: { type: "integer" } }, required: ["start"] } },
    required: ["range"],
  }), { range: { start: 0 } });
  assert.deepEqual(minimalSchemaExample({ anyOf: [{ type: "string" }, { type: "number" }] }), "string");
  assert.deepEqual(minimalSchemaExample({ oneOf: [{ type: "boolean" }] }), false);
  assert.deepEqual(minimalSchemaExample({ type: "array", items: { type: "string" }, minItems: 2 }), ["string", "string"]);
  assert.deepEqual(minimalSchemaExample({ type: "array", items: { type: "string" } }), []);
  assert.deepEqual(minimalSchemaExample({ type: ["null", "string"] }), "string");
  assert.deepEqual(minimalSchemaExample({ type: "number", minimum: 5 }), 5);
  assert.deepEqual(minimalSchemaExample({ type: "string", minLength: 10 }), "stringxxxx");
});
