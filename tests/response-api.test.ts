import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { HttpError } from "../server/utils/http.ts";
import {
  createResponseStreamState,
  failedResponseEvent,
  finishResponseStream,
  messagesFromResponseItems,
  responseEventsFromChatChunk,
  responseFromExecution,
  responseOutputItems,
  startResponseStream,
  validateResponseRequest,
  type ResponseRequestContext,
} from "../server/utils/response-api.ts";
import { ResponseStore } from "../server/utils/response-store.ts";
import { validateChatRequest, type ChatExecution } from "../server/utils/chat-service.ts";
import type { JsonObject, JsonValue, ManagedAccount } from "../server/utils/types.ts";

async function withTempDataDir<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "neuralwatt-response-api-test-"));
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

function functionTool(name = "shell_command"): JsonObject {
  return {
    type: "function",
    name,
    description: "Run a command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: false,
  };
}

function userInput(text: string): JsonObject {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function baseRequest(overrides: JsonObject = {}): JsonObject {
  return {
    model: "test-model",
    input: [userInput("Hello")],
    store: false,
    ...overrides,
  };
}

async function assertHttpError(run: () => Promise<unknown>, expected: { status: number; match?: RegExp; param?: string }): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
    assert.equal(error.status, expected.status);
    if (expected.match) {
      assert.match(error.message, expected.match);
    }
    if (expected.param) {
      assert.equal(error.param, expected.param);
    }
    return;
  }
  assert.fail(`expected HttpError ${expected.status}`);
}

function fakeExecution(overrides: {
  content?: string | null;
  reasoning?: string;
  reasoningContent?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  finishReason?: string;
  usage?: JsonObject;
} = {}): ChatExecution {
  const account = { id: "acc_1", label: "Account" } as ManagedAccount;
  return {
    account,
    completion: {
      id: "chatcmpl_test",
      created: 1_700_000_000,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: (overrides.usage ?? { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } }) as JsonObject,
    },
    message: {
      role: "assistant",
      content: overrides.content === undefined ? "Hello back" : overrides.content,
      ...(overrides.reasoning ? { reasoning: overrides.reasoning } : {}),
      ...(overrides.reasoningContent ? { reasoning_content: overrides.reasoningContent } : {}),
      ...(overrides.toolCalls?.length
        ? { tool_calls: overrides.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) }
        : {}),
    },
    finishReason: overrides.finishReason ?? "stop",
    model: "test-model",
    tools: [],
    upstreamRequest: {},
    upstreamCalls: [],
  };
}

function baseContext(overrides: Partial<ResponseRequestContext> = {}): ResponseRequestContext {
  return {
    model: "test-model",
    tools: [],
    droppedTools: [],
    parallelToolCalls: true,
    store: false,
    inputItems: [userInput("Hello")],
    ...overrides,
  };
}

test("validateResponseRequest converts a simple string input", async () => {
  await withTempDataDir(async () => {
    const { chatRequest, context } = await validateResponseRequest({ model: "test-model", input: "Hi there", store: false });
    assert.equal(chatRequest.model, "test-model");
    assert.deepEqual(chatRequest.messages, [{ role: "user", content: "Hi there" }]);
    assert.equal(context.store, false);
    assert.equal(context.inputItems.length, 1);
  });
});

test("validateResponseRequest maps instructions, tools, tool_choice and budgets", async () => {
  await withTempDataDir(async () => {
    const { chatRequest, context } = await validateResponseRequest(baseRequest({
      instructions: "Be brief.",
      tools: [functionTool()],
      tool_choice: { type: "function", name: "shell_command" },
      max_output_tokens: 500,
      reasoning: { effort: "high", summary: "auto" },
      parallel_tool_calls: false,
      prompt_cache_key: "session-123",
      temperature: 0.4,
      top_p: 0.9,
    }));
    const messages = chatRequest.messages as JsonObject[];
    assert.deepEqual(messages[0], { role: "system", content: "Be brief." });
    assert.deepEqual(messages[1], { role: "user", content: "Hello" });
    assert.deepEqual(chatRequest.tools, [{
      type: "function",
      function: {
        name: "shell_command",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
        strict: false,
      },
    }]);
    assert.deepEqual(chatRequest.tool_choice, { type: "function", function: { name: "shell_command" } });
    assert.equal(chatRequest.max_completion_tokens, 500);
    assert.equal(chatRequest.reasoning_effort, "high");
    assert.equal(chatRequest.parallel_tool_calls, false);
    assert.equal(chatRequest.user, "session-123");
    assert.equal(chatRequest.temperature, 0.4);
    assert.equal(chatRequest.top_p, 0.9);
    assert.equal(context.droppedTools.length, 0);
  });
});

test("validateResponseRequest drops hosted tools and flattens namespaces", async () => {
  await withTempDataDir(async () => {
    const { chatRequest, context } = await validateResponseRequest(baseRequest({
      tools: [
        functionTool(),
        { type: "web_search", external_web_access: false },
        { type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }] },
      ],
    }));
    const chatTools = chatRequest.tools as JsonObject[];
    assert.equal(chatTools.length, 2);
    assert.equal((chatTools[1]!.function as JsonObject).name, "multi_agent_v1.spawn_agent");
    assert.deepEqual(context.droppedTools, ["web_search"]);
  });
});

test("validateResponseRequest harvests tools from additional_tools and namespace input items", async () => {
  await withTempDataDir(async () => {
    const { chatRequest, context } = await validateResponseRequest({
      model: "test-model",
      store: false,
      tool_choice: "auto",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              description: "",
              tools: [
                { type: "custom", name: "exec", description: "Run JS", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } },
                { type: "function", name: "wait", description: "Wait", parameters: { type: "object" } },
              ],
            },
          ],
        },
        {
          type: "namespace",
          name: "collaboration",
          description: "Sub-agents",
          tools: [{ type: "function", name: "spawn_agent", description: "Spawn", parameters: { type: "object" } }],
        },
        userInput("Run something"),
      ],
    });
    const names = (chatRequest.tools as JsonObject[]).map((tool) => (tool.function as JsonObject).name);
    assert.deepEqual(names, ["exec", "wait", "collaboration.spawn_agent"]);
    assert.deepEqual(context.tools.map((tool) => [tool.kind, tool.name]), [
      ["custom", "exec"],
      ["function", "wait"],
      ["function", "collaboration.spawn_agent"],
    ]);
    // The custom exec tool keeps its grammar format for the response echo.
    assert.deepEqual((context.tools[0] as { format?: JsonObject }).format, { type: "grammar", syntax: "lark", definition: "start: SOURCE" });
    // Tool-carrier items never become messages.
    const messages = chatRequest.messages as JsonObject[];
    assert.deepEqual(messages, [{ role: "user", content: "Run something" }]);
    // tool_choice auto with harvested tools must not raise.
    assert.equal(chatRequest.tool_choice, "auto");
  });
});

test("validateResponseRequest accepts tool_choice auto when every tool is dropped", async () => {
  await withTempDataDir(async () => {
    // Hosted tools have no executor on this gateway and are dropped; a client
    // default of tool_choice "auto" must not turn the request into a 400.
    const { chatRequest, context } = await validateResponseRequest({
      model: "test-model",
      store: false,
      tool_choice: "auto",
      tools: [{ type: "web_search" }],
      input: [userInput("Search something")],
    });
    assert.equal(chatRequest.tools, undefined);
    assert.equal(chatRequest.tool_choice, "auto");
    assert.deepEqual(context.droppedTools, ["web_search"]);
    // The downstream chat validation accepts the no-op selection.
    validateChatRequest(chatRequest);
  });
});

test("validateResponseRequest validates named tool_choice against harvested tools", async () => {
  await withTempDataDir(async () => {
    const { chatRequest } = await validateResponseRequest({
      model: "test-model",
      store: false,
      tool_choice: { type: "function", name: "collaboration.spawn_agent" },
      input: [
        { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }] },
        userInput("Delegate"),
      ],
    });
    assert.deepEqual(chatRequest.tool_choice, { type: "function", function: { name: "collaboration.spawn_agent" } });
    await assertHttpError(() => validateResponseRequest({
      model: "test-model",
      store: false,
      tool_choice: { type: "function", name: "collaboration.missing" },
      input: [
        { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }] },
        userInput("Delegate"),
      ],
    }), { status: 400, param: "tool_choice" });
  });
});

test("messagesFromResponseItems matches prefixed custom call names", () => {
  const messages = messagesFromResponseItems([
    userInput("go"),
    { type: "custom_tool_call", name: "functions.exec", input: "exit()", call_id: "call_1" },
    { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
  ], new Set(["exec"]));
  const assistant = messages[1]!;
  assert.equal(assistant.tool_calls?.[0]?.function.name, "functions.exec");
  assert.deepEqual(JSON.parse(assistant.tool_calls![0]!.function.arguments), { input: "exit()" });
});

test("validateResponseRequest wraps custom tools with an input string schema", async () => {
  await withTempDataDir(async () => {
    const { chatRequest, context } = await validateResponseRequest(baseRequest({
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
    }));
    assert.deepEqual(context.tools, [{ kind: "custom", name: "apply_patch", description: "Apply a patch" }]);
    const chatTools = chatRequest.tools as JsonObject[];
    const fn = chatTools[0]!.function as JsonObject;
    assert.equal(fn.name, "apply_patch");
    assert.deepEqual(fn.parameters, {
      type: "object",
      properties: { input: { type: "string", description: "The complete free-form tool input." } },
      required: ["input"],
      additionalProperties: false,
    });
  });
});

test("validateResponseRequest rejects invalid shapes", async () => {
  await withTempDataDir(async () => {
    await assertHttpError(() => validateResponseRequest({ model: "m", store: false }), { status: 400, param: "input" });
    await assertHttpError(() => validateResponseRequest(baseRequest({ input: [] })), { status: 400, param: "input" });
    // Over-limit payloads are 413, not 400: the request shape is valid.
    await assertHttpError(
      () => validateResponseRequest(baseRequest({ input: Array.from({ length: 1_001 }, () => userInput("hi")) })),
      { status: 413, param: "input", match: /item limit/ },
    );
    await assertHttpError(() => validateResponseRequest(baseRequest({ input: [userInput("a")], previous_response_id: "resp_missing" })), {
      status: 400,
      param: "previous_response_id",
      match: /not found/,
    });
    await assertHttpError(() => validateResponseRequest(baseRequest({ tools: [{ type: "function", name: "bad name!" }] })), { status: 400, param: "tools" });
    await assertHttpError(() => validateResponseRequest(baseRequest({ tools: [functionTool()], tool_choice: { type: "function", name: "nope" } })), { status: 400, param: "tool_choice" });
    await assertHttpError(() => validateResponseRequest(baseRequest({ max_output_tokens: 0 })), { status: 400, param: "max_output_tokens" });
    await assertHttpError(() => validateResponseRequest(baseRequest({ store: "yes" as unknown as boolean })), { status: 400, param: "store" });
    await assertHttpError(() => validateResponseRequest(baseRequest({ input: [{ type: "item_reference", id: "msg_1" }] })), { status: 400, param: "input" });
  });
});

test("messagesFromResponseItems groups calls, outputs and reasoning", () => {
  const messages = messagesFromResponseItems([
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Rules" }] },
    userInput("Run something"),
    { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
    { type: "function_call", name: "shell_command", arguments: "{\"command\":\"ls\"}", call_id: "call_1" },
    { type: "function_call", name: "shell_command", arguments: "{\"command\":\"pwd\"}", call_id: "call_2" },
    { type: "function_call_output", call_id: "call_1", output: "files" },
    { type: "function_call_output", call_id: "call_2", output: "cwd" },
  ], new Set());
  assert.deepEqual(messages[0], { role: "developer", content: "Rules" });
  assert.deepEqual(messages[1], { role: "user", content: "Run something" });
  const assistant = messages[2]!;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.reasoning, "thinking...");
  assert.equal(assistant.tool_calls?.length, 2);
  assert.equal(assistant.tool_calls?.[0]?.id, "call_1");
  assert.equal(assistant.tool_calls?.[1]?.function.name, "shell_command");
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_1", content: "files" });
  assert.deepEqual(messages[4], { role: "tool", tool_call_id: "call_2", content: "cwd" });
});

test("messagesFromResponseItems unwraps custom tool calls and outputs", () => {
  const messages = messagesFromResponseItems([
    userInput("Patch it"),
    { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** End Patch", call_id: "call_9" },
    { type: "custom_tool_call_output", call_id: "call_9", output: "done" },
  ], new Set(["apply_patch"]));
  const assistant = messages[1]!;
  assert.equal(assistant.tool_calls?.[0]?.function.name, "apply_patch");
  assert.deepEqual(JSON.parse(assistant.tool_calls![0]!.function.arguments), { input: "*** Begin Patch\n*** End Patch" });
  assert.deepEqual(messages[2], { role: "tool", tool_call_id: "call_9", content: "done" });
});

test("responseFromExecution maps usage, status and output items", async () => {
  await withTempDataDir(async () => {
    const execution = fakeExecution({
      content: "preamble",
      reasoning: "chain",
      toolCalls: [{ id: "call_1", name: "shell_command", arguments: "{\"command\":\"ls\"}" }],
      finishReason: "tool_calls",
    });
    const context = baseContext({ tools: [{ kind: "function", name: "shell_command" }] });
    const response = responseFromExecution(execution, context, "resp_test", 1_700_000_000);
    assert.equal(response.id, "resp_test");
    assert.equal(response.object, "response");
    assert.equal(response.status, "completed");
    assert.equal(response.incomplete_details, null);
    const output = response.output as JsonObject[];
    assert.equal(output.length, 3);
    assert.equal(output[0]!.type, "reasoning");
    assert.equal((output[0]!.summary as JsonObject[])[0]!.text, "chain");
    assert.equal(typeof output[0]!.encrypted_content, "string");
    assert.equal(output[1]!.type, "message");
    assert.equal(((output[1]!.content as JsonObject[])[0]!).text, "preamble");
    assert.equal(output[2]!.type, "function_call");
    assert.equal(output[2]!.call_id, "call_1");
    assert.equal(output[2]!.name, "shell_command");
    assert.equal(output[2]!.arguments, "{\"command\":\"ls\"}");
    assert.deepEqual(response.usage, {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 19,
    });
  });
});

test("responseFromExecution marks length finishes incomplete", async () => {
  await withTempDataDir(async () => {
    const response = responseFromExecution(fakeExecution({ finishReason: "length" }), baseContext(), "resp_len", 1);
    assert.equal(response.status, "incomplete");
    assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
  });
});

test("responseOutputItems unwraps custom tool call input", async () => {
  await withTempDataDir(async () => {
    const execution = fakeExecution({
      content: null,
      toolCalls: [{ id: "call_9", name: "apply_patch", arguments: "{\"input\":\"patch text\"}" }],
      finishReason: "tool_calls",
    });
    const context = baseContext({ tools: [{ kind: "custom", name: "apply_patch" }] });
    const { items } = responseOutputItems(execution, context);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.type, "custom_tool_call");
    assert.equal(items[0]!.input, "patch text");
    assert.equal(items[0]!.call_id, "call_9");
  });
});

test("reasoning encrypted_content round-trips through input items", async () => {
  await withTempDataDir(async () => {
    const execution = fakeExecution({ reasoning: "private chain", reasoningContent: "alt chain" });
    const { reasoningItem } = responseOutputItems(execution, baseContext());
    assert.ok(reasoningItem);
    const messages = messagesFromResponseItems([reasoningItem, { type: "function_call", name: "shell_command", arguments: "{}", call_id: "call_1" }], new Set());
    assert.equal(messages[0]!.reasoning, "private chain");
    assert.equal(messages[0]!.reasoning_content, "alt chain");
  });
});

test("response stream emits the full text lifecycle", async () => {
  await withTempDataDir(async () => {
    const context = baseContext();
    const state = createResponseStreamState(context);
    const events = [...startResponseStream(state)];
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning: "think " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } } },
    ]) {
      events.push(...responseEventsFromChatChunk(chunk as unknown as JsonObject, state));
    }
    events.push(...finishResponseStream(fakeExecution({ content: "Hello world", reasoning: "think " }), state));

    const types = events.map((entry) => entry.event);
    assert.deepEqual(types, [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = events[events.length - 1]!.data.response as JsonObject;
    assert.equal(completed.status, "completed");
    const output = completed.output as JsonObject[];
    assert.equal(output[0]!.type, "reasoning");
    assert.equal(output[1]!.type, "message");
    assert.equal(((output[1]!.content as JsonObject[])[0]!).text, "Hello world");
    assert.deepEqual(completed.usage, {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 19,
    });
    // Streamed item ids are reused in the completed response.
    const messageDone = events.find((entry) => entry.event === "response.output_item.done" && (entry.data.item as JsonObject).type === "message");
    assert.equal((messageDone!.data.item as JsonObject).id, output[1]!.id);
  });
});

test("response stream releases buffered tool calls at completion", async () => {
  await withTempDataDir(async () => {
    const context = baseContext({ tools: [{ kind: "function", name: "shell_command" }] });
    const state = createResponseStreamState(context);
    const events = [...startResponseStream(state)];
    const execution = fakeExecution({
      content: "Running the command.",
      toolCalls: [{ id: "call_1", name: "shell_command", arguments: "{\"command\":\"ls\"}" }],
      finishReason: "tool_calls",
    });
    events.push(...finishResponseStream(execution, state));
    const types = events.map((entry) => entry.event);
    assert.deepEqual(types, [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const argsDone = events.find((entry) => entry.event === "response.function_call_arguments.done");
    assert.equal(argsDone!.data.arguments, "{\"command\":\"ls\"}");
    const completed = events[events.length - 1]!.data.response as JsonObject;
    const output = completed.output as JsonObject[];
    assert.equal(output[0]!.type, "message");
    assert.equal(output[1]!.type, "function_call");
    assert.equal(output[1]!.call_id, "call_1");
  });
});

test("failedResponseEvent produces a terminal failed response", async () => {
  await withTempDataDir(async () => {
    const state = createResponseStreamState(baseContext());
    startResponseStream(state);
    const failed = failedResponseEvent(state, { code: "upstream_error", message: "boom" });
    assert.equal(failed.event, "response.failed");
    const response = failed.data.response as JsonObject;
    assert.equal(response.status, "failed");
    assert.deepEqual(response.error, { code: "upstream_error", message: "boom" });
  });
});

test("ResponseStore persists and serves previous_response_id chains", async () => {
  await withTempDataDir(async () => {
    const store = new ResponseStore();
    await store.save({
      id: "resp_first",
      createdAt: new Date().toISOString(),
      model: "test-model",
      items: [userInput("first turn"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }],
    });
    const loaded = await store.get("resp_first");
    assert.ok(loaded);
    assert.equal(loaded.items.length, 2);

    const { chatRequest, context } = await validateResponseRequest({
      model: "test-model",
      input: [userInput("second turn")],
      previous_response_id: "resp_first",
    });
    const messages = chatRequest.messages as JsonObject[];
    assert.deepEqual(messages[0], { role: "user", content: "first turn" });
    assert.deepEqual(messages[1]!, { role: "assistant", content: "answer" });
    assert.deepEqual(messages[2], { role: "user", content: "second turn" });
    assert.equal(context.previousResponseId, "resp_first");
    assert.equal(context.store, true);
  });
});

test("ResponseStore rejects malformed ids and unknown entries", async () => {
  await withTempDataDir(async () => {
    const store = new ResponseStore();
    assert.equal(await store.get("../../etc/passwd"), undefined);
    assert.equal(await store.get("resp_missing"), undefined);
  });
});

test("validateResponseRequest tolerates codex null reasoning and metadata", async () => {
  await withTempDataDir(async () => {
    const { chatRequest } = await validateResponseRequest(baseRequest({
      reasoning: null,
      include: [],
      client_metadata: { session_id: "abc" },
      tool_choice: "auto",
    }));
    assert.equal(chatRequest.reasoning_effort, undefined);
    assert.equal(chatRequest.tool_choice, "auto");
  });
});

test("validateResponseRequest maps text.format to response_format", async () => {
  await withTempDataDir(async () => {
    const { chatRequest } = await validateResponseRequest(baseRequest({
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } },
    }));
    assert.deepEqual(chatRequest.response_format, {
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    });
  });
});

test("assistant message items keep output text and refusal", () => {
  const messages = messagesFromResponseItems([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }, { type: "refusal", refusal: "no" }] },
  ], new Set());
  assert.equal(messages[0]!.role, "assistant");
  assert.equal(messages[0]!.content, "partial");
  assert.equal(messages[0]!.refusal, "no");
});

test("input images map to chat image parts", () => {
  const messages = messagesFromResponseItems([
    { type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
  ], new Set());
  assert.deepEqual(messages[0]!.content, [
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
  ]);
});

test("chat completion shape stays available for parity checks", async () => {
  await withTempDataDir(async () => {
    const { asChatCompletion } = await import("../server/utils/chat-service.ts");
    const completion = asChatCompletion(fakeExecution({ toolCalls: [{ id: "call_1", name: "shell_command", arguments: "{}" }], finishReason: "tool_calls" }));
    const choice = (completion.choices as JsonObject[])[0]!;
    assert.equal(choice.finish_reason, "tool_calls");
    const message = choice.message as JsonObject;
    assert.equal((message.tool_calls as JsonObject[])[0]!.id, "call_1");
  });
});

test("response stream usage frame without choices is stashed", async () => {
  await withTempDataDir(async () => {
    const state = createResponseStreamState(baseContext());
    startResponseStream(state);
    const events = responseEventsFromChatChunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } } as unknown as JsonObject, state);
    assert.equal(events.length, 0);
    const final = finishResponseStream(fakeExecution({ usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }), state);
    const completed = final[final.length - 1]!.data.response as JsonObject;
    assert.equal((completed.usage as JsonObject).total_tokens, 11);
  });
});

test("validateResponseRequest requires a non-system item", async () => {
  await withTempDataDir(async () => {
    await assertHttpError(
      () => validateResponseRequest({ model: "m", store: false, input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] }] }),
      { status: 400, param: "input" },
    );
  });
});

test("response store round trip survives restart", async () => {
  await withTempDataDir(async () => {
    const first = new ResponseStore();
    await first.save({
      id: "resp_persist",
      createdAt: new Date().toISOString(),
      model: "test-model",
      items: [userInput("kept")],
    });
    const second = new ResponseStore();
    const loaded = await second.get("resp_persist");
    assert.ok(loaded);
    assert.equal(loaded.items.length, 1);
  });
});

test("response stream emits empty message item lifecycle when nothing streamed", async () => {
  await withTempDataDir(async () => {
    const state = createResponseStreamState(baseContext());
    startResponseStream(state);
    const events = finishResponseStream(fakeExecution({ content: "" }), state);
    const types = events.map((entry) => entry.event);
    assert.ok(types.includes("response.output_item.added"));
    assert.ok(types.includes("response.output_text.done"));
    assert.equal(types[types.length - 1], "response.completed");
    const completed = events[events.length - 1]!.data.response as JsonObject;
    const output = completed.output as JsonObject[];
    assert.equal(output[0]!.type, "message");
    assert.equal(((output[0]!.content as JsonObject[])[0]!).text, "");
  });
});

test("tool output items accept structured output objects", () => {
  const messages = messagesFromResponseItems([
    userInput("go"),
    { type: "function_call", name: "shell_command", arguments: "{}", call_id: "call_1" },
    { type: "function_call_output", call_id: "call_1", output: { content: [{ type: "output_text", text: "line1" }, { type: "output_text", text: "line2" }] } },
  ], new Set());
  assert.equal(messages[2]!.content, "line1\nline2");
});

test("dropped tool types never reach the chat request", async () => {
  await withTempDataDir(async () => {
    const { chatRequest } = await validateResponseRequest(baseRequest({
      tools: [{ type: "web_search" }, { type: "mcp", server_label: "x" }],
    }));
    assert.equal(chatRequest.tools, undefined);
  });
});

test("response stream reuses reasoning id in completed output", async () => {
  await withTempDataDir(async () => {
    const state = createResponseStreamState(baseContext());
    startResponseStream(state);
    responseEventsFromChatChunk({ choices: [{ index: 0, delta: { reasoning: "abc" }, finish_reason: null }] } as unknown as JsonObject, state);
    const events = finishResponseStream(fakeExecution({ content: "done", reasoning: "abc" }), state);
    const reasoningDone = events.find((entry) => entry.event === "response.output_item.done" && (entry.data.item as JsonObject).type === "reasoning");
    const completed = events[events.length - 1]!.data.response as JsonObject;
    const output = completed.output as JsonObject[];
    assert.equal((reasoningDone!.data.item as JsonObject).id, output[0]!.id);
    assert.equal(output[0]!.type, "reasoning");
  });
});

test("JsonValue import sanity", () => {
  const value: JsonValue = { a: [1, "x", null] };
  assert.equal(typeof value, "object");
});
