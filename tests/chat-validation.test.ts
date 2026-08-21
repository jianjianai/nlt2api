import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chatChunksFromUpstreamFrame,
  createChatStreamState,
  executeChatRequest,
  isThinkingInterrupted,
  locatedSchemaErrorText,
  repairMessages,
  validateChatRequest,
} from "../server/utils/chat-service.ts";
import { getProxyConfig, resetProxyConfigForTests } from "../server/utils/config.ts";
import { HttpError } from "../server/utils/http.ts";
import { FINAL_REPLY_MARKER, InvalidStructuredToolCallsError, withToolCallContract } from "../server/utils/tool-calls.ts";
import type { ChatMessage, JsonObject, JsonValue, ToolDefinition, UpstreamCompletion } from "../server/utils/types.ts";

const tool = {
  type: "function",
  function: {
    name: "lookup",
    description: "Find things",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
} as unknown as JsonValue;

function validRequest(overrides: JsonObject = {}): JsonObject {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "Hello" }] as unknown as JsonValue,
    ...overrides,
  };
}

interface ErrorExpectation {
  status: number;
  message?: string;
  match?: RegExp;
  param?: string;
}

function assertChatHttpError(fn: () => unknown, expected: ErrorExpectation): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
    assert.equal(error.status, expected.status);
    if (expected.message !== undefined) {
      assert.equal(error.message, expected.message);
    }
    if (expected.match !== undefined) {
      assert.match(error.message, expected.match);
    }
    if (expected.param !== undefined) {
      assert.equal(error.param, expected.param);
    }
    return;
  }
  assert.fail(`expected HttpError ${expected.status}: ${expected.message ?? String(expected.match)}`);
}

async function withEmptyDataDir<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "neuralwatt-chat-validation-test-"));
  const previous = process.env.NEURALWATT_DATA_DIR;
  process.env.NEURALWATT_DATA_DIR = dir;
  resetProxyConfigForTests();
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.NEURALWATT_DATA_DIR;
    } else {
      process.env.NEURALWATT_DATA_DIR = previous;
    }
    resetProxyConfigForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

test("validateChatRequest returns the parsed model, messages and tools", () => {
  const request = validRequest({ tools: [tool] });
  const validated = validateChatRequest(request);

  assert.equal(validated.model, "test-model");
  assert.equal(validated.messages.length, 1);
  // parseMessages returns the same message objects it validated.
  assert.equal(validated.messages[0], (request.messages as JsonObject[])[0]);
  assert.equal(validated.tools.length, 1);
  assert.equal(validated.tools[0]?.function.name, "lookup");
});

test("validateChatRequest normalizes tool definitions", () => {
  const validated = validateChatRequest(validRequest({
    tools: [{
      type: "function",
      extra: "dropped",
      function: {
        name: "lookup",
        description: "Find things",
        parameters: { type: "object" },
        strict: true,
        extra: "dropped",
      },
    } as unknown as JsonValue],
  }));

  assert.deepEqual(validated.tools, [{
    type: "function",
    function: {
      name: "lookup",
      description: "Find things",
      parameters: { type: "object" },
      strict: true,
    },
  }]);
});

test("validateChatRequest falls back to the configured default model", () => {
  for (const model of [undefined, null, ""] as unknown as JsonValue[]) {
    const request = validRequest();
    if (model === undefined) {
      delete request.model;
    } else {
      request.model = model;
    }
    assert.equal(validateChatRequest(request).model, getProxyConfig().defaultModel);
  }
});

test("validateChatRequest accepts valid tool_choice and sampling variants", () => {
  for (const overrides of [
    { stream: true, temperature: 0, top_p: 1, stop: "end" },
    { stop: ["a", "b", "c", "d"] },
    { n: 1, max_tokens: 1 },
    { max_completion_tokens: 100_000 },
    { tools: [tool], tool_choice: "auto" },
    { tools: [tool], tool_choice: "required" },
    { tools: [tool], tool_choice: { type: "function", function: { name: "lookup" } } },
    { tools: [tool], tool_choice: "none", parallel_tool_calls: false },
    { tool_choice: "none" },
    // Every tool_choice is a no-op without tools: the turn is a non-tool turn
    // either way, and clients send these even when no tool declarations survive.
    { tool_choice: "auto" },
    { tool_choice: "required" },
    { tool_choice: { type: "function", function: { name: "lookup" } } },
  ] as JsonObject[]) {
    const validated = validateChatRequest(validRequest(overrides));
    assert.equal(validated.model, "test-model");
  }
});

test("validateChatRequest rejects invalid requests with unchanged errors", () => {
  const cases: Array<{ name: string; mutate: (request: JsonObject) => void; expected: ErrorExpectation }> = [
    {
      name: "non-boolean stream",
      mutate: (request) => { request.stream = "yes"; },
      expected: { status: 400, message: "`stream` must be a boolean.", param: "stream" },
    },
    {
      name: "temperature above range",
      mutate: (request) => { request.temperature = 2.5; },
      expected: { status: 400, message: "`temperature` must be between 0 and 2.", param: "temperature" },
    },
    {
      name: "negative temperature",
      mutate: (request) => { request.temperature = -0.1; },
      expected: { status: 400, message: "`temperature` must be between 0 and 2.", param: "temperature" },
    },
    {
      name: "top_p above range",
      mutate: (request) => { request.top_p = 1.5; },
      expected: { status: 400, message: "`top_p` must be between 0 and 1.", param: "top_p" },
    },
    {
      name: "stop with more than four entries",
      mutate: (request) => { request.stop = ["a", "b", "c", "d", "e"]; },
      expected: { status: 400, message: "`stop` must be a string or an array of at most four strings.", param: "stop" },
    },
    {
      name: "n other than 1",
      mutate: (request) => { request.n = 2; },
      expected: { status: 400, message: "Only n=1 is supported by the portal adapter.", param: "n" },
    },
    {
      name: "non-integer max_tokens",
      mutate: (request) => { request.max_tokens = 10.5; },
      expected: { status: 400, message: "`max_tokens` must be a positive integer.", param: "max_tokens" },
    },
    {
      name: "zero max_completion_tokens",
      mutate: (request) => { request.max_completion_tokens = 0; },
      expected: { status: 400, message: "`max_tokens` must be a positive integer.", param: "max_tokens" },
    },
    {
      name: "non-boolean parallel_tool_calls",
      mutate: (request) => { request.parallel_tool_calls = "no"; },
      expected: { status: 400, message: "`parallel_tool_calls` must be a boolean.", param: "parallel_tool_calls" },
    },
    {
      name: "non-string model",
      mutate: (request) => { request.model = 42; },
      expected: { status: 400, message: "`model` must be a string.", param: "model" },
    },
    {
      name: "over-long model",
      mutate: (request) => { request.model = "x".repeat(201); },
      expected: { status: 400, message: "`model` must be a string.", param: "model" },
    },
    {
      name: "missing messages",
      mutate: (request) => { delete request.messages; },
      expected: { status: 400, message: "`messages` must be a non-empty array.", param: "messages" },
    },
    {
      name: "empty messages",
      mutate: (request) => { request.messages = []; },
      expected: { status: 400, message: "`messages` must be a non-empty array.", param: "messages" },
    },
    {
      name: "history above the message cap",
      mutate: (request) => {
        request.messages = Array.from({ length: getProxyConfig().maxChatMessages + 1 }, () => ({ role: "user", content: "x" })) as unknown as JsonValue;
      },
      expected: { status: 413, message: "`messages` exceeds the supported history limit (limit 10000 messages; raise NEURALWATT_MAX_CHAT_MESSAGES).", param: "messages" },
    },
    {
      name: "unsupported role",
      mutate: (request) => { request.messages = [{ role: "bot", content: "x" }] as unknown as JsonValue; },
      expected: { status: 400, message: "messages[0] has an unsupported role.", param: "messages" },
    },
    {
      name: "tool message without a valid id",
      mutate: (request) => { request.messages = [{ role: "tool", content: "x" }] as unknown as JsonValue; },
      expected: { status: 400, message: "messages[0].tool_call_id must be a valid tool-call ID.", param: "messages" },
    },
    {
      name: "tool message with oversized content",
      mutate: (request) => {
        request.messages = [{ role: "tool", tool_call_id: "call_1", content: "x".repeat(256 * 1_024 + 1) }] as unknown as JsonValue;
      },
      expected: { status: 400, message: "messages[0].content exceeds the 262144 byte tool-result limit.", param: "messages" },
    },
    {
      name: "more than 512 tools",
      mutate: (request) => {
        request.tools = Array.from({ length: 513 }, (_, index) => ({
          type: "function",
          function: { name: `tool_${index}` },
        })) as unknown as JsonValue;
      },
      expected: { status: 400, message: "`tools` must contain at most 512 function definitions.", param: "tools" },
    },
    {
      name: "oversized tool definitions",
      mutate: (request) => {
        request.tools = [{
          type: "function",
          function: { name: "lookup", description: "x".repeat(1025 * 1_024) },
        }] as unknown as JsonValue;
      },
      expected: { status: 400, message: "`tools` exceeds the supported definition size.", param: "tools" },
    },
    {
      name: "tool with an invalid name",
      mutate: (request) => {
        request.tools = [{ type: "function", function: { name: "not a valid name!" } }] as unknown as JsonValue;
      },
      expected: { status: 400, message: "tools[0] must be an OpenAI function definition with a valid name.", param: "tools" },
    },
    {
      name: "duplicate tool names",
      mutate: (request) => { request.tools = [tool, tool]; },
      expected: { status: 400, message: "Tool name `lookup` is duplicated.", param: "tools" },
    },
    {
      name: "non-object tool parameters",
      mutate: (request) => {
        request.tools = [{ type: "function", function: { name: "lookup", parameters: [] } }] as unknown as JsonValue;
      },
      expected: { status: 400, message: "tools[0].function.parameters must be a JSON Schema object.", param: "tools" },
    },
    {
      name: "invalid tool schema",
      mutate: (request) => {
        request.tools = [{
          type: "function",
          function: { name: "lookup", parameters: { type: "definitely-not-a-type" } },
        }] as unknown as JsonValue;
      },
      expected: { status: 400, match: /^tools\[0\]\.function\.parameters is invalid: /, param: "tools" },
    },
    {
      name: "tool_choice referencing an unknown function",
      mutate: (request) => {
        request.tools = [tool];
        request.tool_choice = { type: "function", function: { name: "nope" } } as unknown as JsonValue;
      },
      expected: { status: 400, message: "`tool_choice` must reference one of the supplied functions.", param: "tool_choice" },
    },
  ];

  for (const { name, mutate, expected } of cases) {
    const request = validRequest();
    mutate(request);
    assertChatHttpError(() => validateChatRequest(request), expected);
  }
});

test("validateChatRequest still surfaces malformed history tool calls early", () => {
  assert.throws(
    () => validateChatRequest(validRequest({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ] as unknown as JsonValue,
      tools: [tool],
    })),
    (error: unknown) => error instanceof InvalidStructuredToolCallsError,
  );
});

test("validateChatRequest prebuilds the contracted upstream messages", () => {
  const request = validRequest({ tools: [tool] });
  const validated = validateChatRequest(request);
  const expected = withToolCallContract(
    [{ role: "user", content: "Hello" }],
    validated.tools,
    undefined,
    true,
  );
  assert.deepEqual(validated.upstreamMessages, expected);
});

test("validateChatRequest prebuilds plain portal messages when no tools are declared", () => {
  const validated = validateChatRequest(validRequest());
  assert.deepEqual(validated.upstreamMessages, [{ role: "user", content: "Hello" }]);
});

test("validateChatRequest prebuilds marked history for tool turns", () => {
  const validated = validateChatRequest(validRequest({
    tools: [tool],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "again" },
    ] as unknown as JsonValue,
  }));
  const roles = validated.upstreamMessages.map((message) => message.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "user", "user"]);
  assert.match(String(validated.upstreamMessages[0]?.content), /IMPORTANT ADAPTER OVERRIDE/);
  assert.ok(String(validated.upstreamMessages[2]?.content).startsWith(FINAL_REPLY_MARKER));
  assert.match(String(validated.upstreamMessages.at(-1)?.content), /IMPORTANT TOOL TURN REMINDER/);
});

test("validateChatRequest prebuilds serialized tool-call history for tool turns", () => {
  const validated = validateChatRequest(validRequest({
    tools: [tool],
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"x"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "user", content: "again" },
    ] as unknown as JsonValue,
  }));
  const roles = validated.upstreamMessages.map((message) => message.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool", "user", "user"]);
  const assistant = validated.upstreamMessages[2];
  assert.equal(assistant?.tool_calls, undefined);
  const envelope = JSON.parse(String(assistant?.content));
  assert.equal(envelope.type, "tool_calls");
  assert.deepEqual(envelope.tool_calls, [{ name: "lookup", arguments: { query: "x" } }]);
});

test("executeChatRequest validates when no validation result is supplied", async () => {
  await withEmptyDataDir(async () => {
    await assert.rejects(
      executeChatRequest(validRequest({ temperature: 5 })),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 400);
        assert.equal(error.message, "`temperature` must be between 0 and 2.");
        assert.equal(error.param, "temperature");
        return true;
      },
    );
  });
});

test("executeChatRequest trusts a supplied validation result instead of re-validating", async () => {
  await withEmptyDataDir(async () => {
    const validated = validateChatRequest(validRequest());
    // This request would fail validation (temperature 5). Reaching the account
    // scheduler's 503 proves the supplied validation was used as-is.
    await assert.rejects(
      executeChatRequest(validRequest({ temperature: 5 }), { validated }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 503);
        assert.equal(error.code, "no_account_available");
        return true;
      },
    );
  });
});

function contentFrame(content: string): UpstreamCompletion {
  return { choices: [{ delta: { role: "assistant", content } }] } as UpstreamCompletion;
}

function streamContents(
  frames: UpstreamCompletion[],
  request: JsonObject,
): { streamed: string[]; state: ReturnType<typeof createChatStreamState> } {
  const state = createChatStreamState(request);
  const streamed: string[] = [];
  for (const frame of frames) {
    for (const chunk of chatChunksFromUpstreamFrame(frame, state)) {
      const delta = (chunk.choices as Array<{ delta: { content?: string } }>)[0]?.delta;
      if (typeof delta?.content === "string") {
        streamed.push(delta.content);
      }
    }
  }
  return { streamed, state };
}

test("streaming tool turn holds a split marker, then streams the final reply", () => {
  const { streamed, state } = streamContents([
    contentFrame("@@FINAL"),
    contentFrame("_REPLY@@The answer"),
    contentFrame(" is 42."),
  ], validRequest({ tools: [tool] }));
  assert.deepEqual(streamed, ["The answer", " is 42."]);
  assert.equal(state.toolContentMode, "final");
  assert.equal(state.contentSent, true);
});

test("streaming tool turn tolerates leading whitespace before the final marker", () => {
  const { streamed, state } = streamContents([
    contentFrame("\n\n"),
    contentFrame("@@FINAL_REPLY@@"),
    contentFrame("Done."),
  ], validRequest({ tools: [tool] }));
  assert.deepEqual(streamed, ["Done."]);
  assert.equal(state.toolContentMode, "final");
});

test("streaming tool turn suppresses content that diverges from the marker", () => {
  const { streamed, state } = streamContents([
    contentFrame("@"),
    contentFrame("mention someone"),
  ], validRequest({ tools: [tool] }));
  assert.deepEqual(streamed, []);
  assert.equal(state.toolContentMode, "tool");
  assert.equal(state.contentSent, false);
});

test("streaming tool turn suppresses tool-call JSON from the client stream", () => {
  const { streamed, state } = streamContents([
    contentFrame('{"type":"tool_calls"'),
    contentFrame(',"tool_calls":[]}'),
  ], validRequest({ tools: [tool] }));
  assert.deepEqual(streamed, []);
  assert.equal(state.toolContentMode, "tool");
});

test("streaming non-tool turn forwards content immediately", () => {
  const { streamed, state } = streamContents([
    contentFrame("Hello"),
    contentFrame(" world"),
  ], validRequest());
  assert.deepEqual(streamed, ["Hello", " world"]);
  assert.equal(state.toolContentMode, "final");
});


test("located schema errors include the offending source position", () => {
  const text = locatedSchemaErrorText(
    '{"query": 123}',
    { valid: false, errors: [{ instancePath: "/query", message: "must be string", keyword: "type" }] },
  );
  assert.match(text, /\/query/);
  assert.match(text, /line 1, column 11/);
  assert.match(text, /must be string/);
});

test("isThinkingInterrupted only accepts a length stop with empty content and reasoning", () => {
  const completion = (message: JsonObject, finishReason: string | null): UpstreamCompletion => ({
    choices: [{ index: 0, message, finish_reason: finishReason }],
  } as unknown as UpstreamCompletion);

  // Reasoning cut off mid-thought: continued.
  assert.equal(isThinkingInterrupted(completion(
    { role: "assistant", content: "", reasoning: "partial thought" },
    "length",
  )), true);
  assert.equal(isThinkingInterrupted(completion(
    { role: "assistant", content: null, reasoning_content: "partial thought" },
    "length",
  )), true);

  // No reasoning to continue from.
  assert.equal(isThinkingInterrupted(completion(
    { role: "assistant", content: "" },
    "length",
  )), false);

  // A truncated non-empty answer is returned as-is, not continued.
  assert.equal(isThinkingInterrupted(completion(
    { role: "assistant", content: "partial answer", reasoning: "thought" },
    "length",
  )), false);

  // A natural stop is not an interruption.
  assert.equal(isThinkingInterrupted(completion(
    { role: "assistant", content: "", reasoning: "thought" },
    "stop",
  )), false);

  // Native tool calls already produced output.
  assert.equal(isThinkingInterrupted(completion(
    {
      role: "assistant",
      content: "",
      reasoning: "thought",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    "length",
  )), false);
});

const lookupTool: ToolDefinition = {
  type: "function",
  function: {
    name: "lookup",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};
const otherTool: ToolDefinition = {
  type: "function",
  function: { name: "other", parameters: { type: "object", properties: {} } },
};

test("repair messages stay static before the escalation attempt", () => {
  const candidate: ChatMessage = {
    role: "assistant",
    content: '{"type":"tool_calls","tool_calls":[{"name":"lookup","arguments":{"query":123}}]}',
  };
  for (const attempt of [1, 2]) {
    const [rejection, correction] = repairMessages({
      error: "Tool `lookup` arguments failed schema validation:\n- /query: must be string",
      attempt,
      candidate,
      tools: [lookupTool],
      toolChoice: "auto",
      parallelToolCalls: true,
    });
    assert.equal(rejection?.role, "tool");
    assert.equal(correction?.role, "user");
    assert.ok(!String(correction?.content).includes("Escalated repair"));
  }
});

test("repair escalation embeds a schema-derived skeleton naming the failed functions", () => {
  const candidate: ChatMessage = {
    role: "assistant",
    content: '{"type":"tool_calls","tool_calls":[{"name":"lookup","arguments":{"query":123}}]}',
  };
  const [, correction] = repairMessages({
    error: "Tool `lookup` arguments failed schema validation:\n- /query: must be string",
    attempt: 3,
    candidate,
    tools: [lookupTool],
    toolChoice: "auto",
    parallelToolCalls: true,
  });
  const content = String(correction?.content);
  assert.ok(content.includes("Escalated repair"));
  assert.ok(content.includes('{"type":"tool_calls","tool_calls":[{"name":"lookup","arguments":{"query":"string"}}]}'));
});

test("repair escalation reads names from normalized tool_calls and honors parallel_tool_calls", () => {
  const candidate: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
      { id: "call_2", type: "function", function: { name: "other", arguments: "{}" } },
    ],
  };
  const base = {
    error: "schema mismatch",
    attempt: 4,
    candidate,
    tools: [lookupTool, otherTool],
    toolChoice: "auto" as const,
  };
  const parallel = String(repairMessages({ ...base, parallelToolCalls: true })[1]?.content);
  assert.ok(parallel.includes('"name":"lookup"'));
  assert.ok(parallel.includes('"name":"other"'));
  const single = String(repairMessages({ ...base, parallelToolCalls: false })[1]?.content);
  assert.ok(single.includes('"name":"lookup"'));
  assert.ok(!single.includes('"name":"other"'));
});

test("repair escalation falls back to the forced tool_choice and to generic guidance", () => {
  const emptyCandidate: ChatMessage = { role: "assistant", content: "" };
  const forced = repairMessages({
    error: "no envelope",
    attempt: 5,
    candidate: emptyCandidate,
    tools: [lookupTool],
    toolChoice: { type: "function", function: { name: "lookup" } },
    parallelToolCalls: true,
  });
  assert.ok(String(forced[1]?.content).includes('"name":"lookup"'));

  const proseCandidate: ChatMessage = { role: "assistant", content: "I could not decide." };
  const generic = repairMessages({
    error: "no envelope",
    attempt: 3,
    candidate: proseCandidate,
    tools: [lookupTool],
    toolChoice: "auto",
    parallelToolCalls: true,
  });
  const content = String(generic[1]?.content);
  assert.ok(content.includes("Escalated repair: re-read the declared function list"));
  assert.ok(!content.includes('"tool_calls":[{"name"'));
});
