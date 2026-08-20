import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeChatRequest,
  validateChatRequest,
} from "../server/utils/chat-service.ts";
import { getProxyConfig, resetProxyConfigForTests } from "../server/utils/config.ts";
import { HttpError } from "../server/utils/http.ts";
import { InvalidStructuredToolCallsError } from "../server/utils/tool-calls.ts";
import type { JsonObject, JsonValue } from "../server/utils/types.ts";

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
        request.messages = Array.from({ length: 1_001 }, () => ({ role: "user", content: "x" })) as unknown as JsonValue;
      },
      expected: { status: 400, message: "`messages` exceeds the supported history limit.", param: "messages" },
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
      name: "more than 64 tools",
      mutate: (request) => {
        request.tools = Array.from({ length: 65 }, (_, index) => ({
          type: "function",
          function: { name: `tool_${index}` },
        })) as unknown as JsonValue;
      },
      expected: { status: 400, message: "`tools` must contain at most 64 function definitions.", param: "tools" },
    },
    {
      name: "oversized tool definitions",
      mutate: (request) => {
        request.tools = [{
          type: "function",
          function: { name: "lookup", description: "x".repeat(257 * 1_024) },
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
      name: "tool_choice without tools",
      mutate: (request) => { request.tool_choice = "required"; },
      expected: { status: 400, message: "`tool_choice` requires at least one function in `tools`.", param: "tool_choice" },
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

