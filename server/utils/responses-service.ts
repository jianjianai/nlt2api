import { createHash, randomUUID } from "node:crypto";
import { executeChatRequest, parseTools } from "~/server/utils/chat-service.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import { HttpError } from "~/server/utils/http.ts";
import { responsesStreamEvents } from "~/server/utils/responses-events.ts";
import { responseEnvelopeFields, responseUsage } from "~/server/utils/responses-compat.ts";
import { ProxyRequestError } from "~/server/utils/request-errors.ts";
import { ResponseStateLimitError, stateStore } from "~/server/utils/state-store.ts";
import type { ChatMessage, JsonObject, JsonValue, ResponseState, ToolCallAdapterTrace, ToolDefinition } from "~/server/utils/types.ts";

interface ResponseExecution {
  response: JsonObject;
  streamEvents: Array<{ event: string; data: JsonObject }>;
  accountId: string;
  accountLabel: string;
  upstreamRequest: JsonObject;
  upstreamResponse: JsonObject;
  toolCallAdapter?: ToolCallAdapterTrace;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const RESPONSE_STATE_OVERHEAD_BYTES = 32 * 1_024;

function validCallId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function responseStateReserve(request: JsonObject, maxBytes: number): number {
  if (request.store === false) {
    return 0;
  }
  const requested = typeof request.max_output_tokens === "number"
    && Number.isInteger(request.max_output_tokens)
    && request.max_output_tokens > 0
    && request.max_output_tokens <= DEFAULT_MAX_OUTPUT_TOKENS
    ? request.max_output_tokens
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const projected = RESPONSE_STATE_OVERHEAD_BYTES + requested * 16;
  return Math.min(Math.floor(maxBytes / 2), projected);
}

function responseStickyKey(user: unknown): string | undefined {
  if (typeof user !== "string" || !user) {
    return undefined;
  }
  return `responses_user_${createHash("sha256").update(user).digest("base64url")}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function contentToChat(value: unknown): JsonValue {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return value === undefined || value === null ? "" : JSON.stringify(value);
  }
  return value.map((part) => {
    const item = asRecord(part);
    if (!item) {
      throw new HttpError(400, "Responses content parts must be objects.", "invalid_request_error", "input");
    }
    const type = item.type;
    if (type === "input_text" || type === "output_text" || type === "text") {
      return { type: "text", text: typeof item.text === "string" ? item.text : "" };
    }
    if (type === "input_image") {
      const image = asRecord(item.image_url);
      const imageUrl = typeof item.image_url === "string" ? item.image_url : image?.url;
      if (typeof imageUrl !== "string") {
        throw new HttpError(400, "input_image requires an image_url.", "invalid_request_error", "input");
      }
      const detail = image?.detail ?? item.detail;
      if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
        throw new HttpError(400, "input_image detail must be auto, low, or high.", "invalid_request_error", "input");
      }
      return {
        type: "image_url",
        image_url: { url: imageUrl, ...(typeof detail === "string" ? { detail } : {}) },
      };
    }
    if (type === "image_url") {
      return item as JsonValue;
    }
    throw new HttpError(400, `Unsupported Responses content type \`${String(type)}\`.`, "invalid_request_error", "input");
  }) as unknown as JsonValue;
}

function outputToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const part = asRecord(item);
      return typeof part?.text === "string" ? part.text : "";
    }).join("\n");
  }
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function responseTools(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value)) {
    return parseTools(value);
  }
  if (value.length > 64) {
    throw new HttpError(400, "`tools` must contain at most 64 entries.", "invalid_request_error", "tools");
  }
  const converted = value.flatMap((raw, index) => {
    const tool = asRecord(raw);
    // Codex sends its optional multi-agent controls as a vendor `namespace`
    // group. Those controls are not OpenAI function tools, so keeping them
    // would let an unsupported extension prevent the ordinary tool loop.
    if (tool?.type === "namespace") {
      if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
        throw new HttpError(400, `tools[${index}] is not a valid tool namespace.`, "invalid_request_error", "tools");
      }
      return [];
    }
    if (tool?.type === "web_search" || tool?.type === "web_search_preview") {
      return [];
    }
    if (tool?.type !== "function" || typeof tool.name !== "string") {
      return [raw];
    }
    return [{
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      },
    }];
  });
  return parseTools(converted);
}

function functionCallOutputToChat(value: unknown): JsonValue {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    // Function outputs may carry the same text/image content parts as a
    // Responses input item. Preserve those parts for Kimi vision follow-ups;
    // unsupported files fail explicitly in contentToChat instead of vanishing.
    return contentToChat(value);
  }
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function responseFormatFromText(value: unknown): JsonObject | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = asRecord(value);
  if (!text) {
    throw new HttpError(400, "`text` must be an object.", "invalid_request_error", "text");
  }
  if (text.format === undefined || text.format === null) {
    return undefined;
  }
  const format = asRecord(text.format);
  if (!format || typeof format.type !== "string") {
    throw new HttpError(400, "`text.format` must be an object with a type.", "invalid_request_error", "text.format");
  }
  if (format.type === "text") {
    return undefined;
  }
  if (format.type === "json_object") {
    return { type: "json_object" };
  }
  throw new HttpError(
    400,
    "This adapter supports only `text.format` types `text` and `json_object`.",
    "invalid_request_error",
    "text.format",
  );
}

function responseToolChoice(value: unknown): JsonValue | undefined {
  const choice = asRecord(value);
  if (choice?.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return value as JsonValue | undefined;
}

function responseReasoningEffort(reasoningValue: unknown, directValue: unknown): string | undefined {
  let direct: string | undefined;
  if (directValue !== undefined) {
    if (typeof directValue !== "string" || !directValue.trim() || directValue.length > 32) {
      throw new HttpError(400, "`reasoning_effort` must be a non-empty string.", "invalid_request_error", "reasoning_effort");
    }
    direct = directValue.trim();
  }
  if (reasoningValue === undefined || reasoningValue === null) {
    return direct;
  }
  const reasoning = asRecord(reasoningValue);
  if (!reasoning) {
    throw new HttpError(400, "`reasoning` must be an object.", "invalid_request_error", "reasoning");
  }
  const unsupported = Object.keys(reasoning).filter((key) => key !== "effort");
  if (unsupported.length > 0) {
    throw new HttpError(
      400,
      "This adapter currently supports only `reasoning.effort`.",
      "invalid_request_error",
      "reasoning",
    );
  }
  if (reasoning.effort === undefined) {
    return direct;
  }
  if (typeof reasoning.effort !== "string" || !reasoning.effort.trim() || reasoning.effort.length > 32) {
    throw new HttpError(400, "`reasoning.effort` must be a non-empty string.", "invalid_request_error", "reasoning.effort");
  }
  const effort = reasoning.effort.trim();
  if (direct && direct !== effort) {
    throw new HttpError(
      400,
      "`reasoning.effort` conflicts with `reasoning_effort`.",
      "invalid_request_error",
      "reasoning",
    );
  }
  return effort;
}

function responseInstructionMessages(value: unknown): ChatMessage[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    // The Portal browser route guarantees `system` but not `developer`; this
    // preserves Responses instruction precedence through the upstream adapter.
    return [{ role: "system", content: value }];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "`instructions` must be a string or an array.", "invalid_request_error", "instructions");
  }

  const records = value.map(asRecord);
  if (records.length > 0 && records.every((item) => item && ["system", "developer"].includes(String(item.role)))) {
    return records.map((item) => ({
      role: "system",
      content: contentToChat(item!.content),
    }));
  }
  return [{ role: "system", content: contentToChat(value) }];
}

function inputItems(value: unknown): ChatMessage[] {
  if (typeof value === "string") {
    return [{ role: "user", content: value }];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "`input` must be a string or array of Responses input items.", "invalid_request_error", "input");
  }

  const messages: ChatMessage[] = [];
  let pendingCalls: ChatMessage | undefined;
  for (const [index, raw] of value.entries()) {
    const item = asRecord(raw);
    if (!item) {
      throw new HttpError(400, `input[${index}] must be an object.`, "invalid_request_error", "input");
    }
    const type = item.type;
    if (type === "function_call_output") {
      const callId = item.call_id;
      if (!validCallId(callId)) {
        throw new HttpError(400, `input[${index}].call_id must be a valid tool-call ID.`, "invalid_request_error", "input");
      }
      messages.push({ role: "tool", tool_call_id: callId, content: functionCallOutputToChat(item.output) });
      pendingCalls = undefined;
      continue;
    }
    if (type === "function_call") {
      const callId = item.call_id;
      const name = item.name;
      const argumentsValue = item.arguments;
      if (!validCallId(callId) || typeof name !== "string" || typeof argumentsValue !== "string") {
        throw new HttpError(400, `input[${index}] is not a valid function_call item.`, "invalid_request_error", "input");
      }
      if (!pendingCalls) {
        pendingCalls = { role: "assistant", content: "", tool_calls: [] };
        messages.push(pendingCalls);
      }
      pendingCalls.tool_calls!.push({ id: callId, type: "function", function: { name, arguments: argumentsValue } });
      continue;
    }

    if (type === "reasoning") {
      // Preserve a reasoning summary when clients replay Responses output as
      // input. Portal accepts the same optional reasoning fields on chat
      // assistant messages, so this remains available to later turns without
      // exposing provider-specific encrypted reasoning content.
      const summary = outputToText(item.summary);
      messages.push({
        role: "assistant",
        content: "",
        reasoning: summary,
        reasoning_content: summary,
      });
      pendingCalls = undefined;
      continue;
    }

    pendingCalls = undefined;
    const role = item.role;
    if ((type === "message" || !type) && ["system", "developer", "user", "assistant"].includes(String(role))) {
      messages.push({ role: role as ChatMessage["role"], content: contentToChat(item.content) });
      continue;
    }
    throw new HttpError(400, `Unsupported Responses input item type \`${String(type)}\`.`, "invalid_request_error", "input");
  }
  return messages;
}

function responseOutput(message: ChatMessage, status: "completed" | "incomplete"): JsonObject[] {
  const output: JsonObject[] = [];
  // Only expose an explicit provider summary. `reasoning_content` is commonly
  // raw chain-of-thought and is retained for internal Chat replay instead.
  const reasoning = typeof message.reasoning === "string" ? message.reasoning : "";
  if (reasoning) {
    output.push({
      id: `rs_${randomUUID().replaceAll("-", "")}`,
      type: "reasoning",
      status,
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }
  if (message.tool_calls?.length) {
    output.push(...message.tool_calls.map((call) => ({
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      type: "function_call",
      status,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })));
    return output;
  }
  output.push({
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", text: outputToText(message.content), annotations: [], logprobs: [] }],
  });
  return output;
}

export async function executeResponsesRequest(request: JsonObject): Promise<ResponseExecution> {
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw new HttpError(400, "`stream` must be a boolean.", "invalid_request_error", "stream");
  }
  if (request.store !== undefined && typeof request.store !== "boolean") {
    throw new HttpError(400, "`store` must be a boolean.", "invalid_request_error", "store");
  }
  if (request.previous_response_id !== undefined && request.previous_response_id !== null && typeof request.previous_response_id !== "string") {
    throw new HttpError(400, "`previous_response_id` must be a string.", "invalid_request_error", "previous_response_id");
  }
  if (typeof request.previous_response_id === "string" && (request.previous_response_id.length === 0 || request.previous_response_id.length > 200)) {
    throw new HttpError(400, "`previous_response_id` has an invalid length.", "invalid_request_error", "previous_response_id");
  }
  if (request.user !== undefined && request.user !== null && typeof request.user !== "string") {
    throw new HttpError(400, "`user` must be a string.", "invalid_request_error", "user");
  }
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  const previous = previousId ? await stateStore.getResponseState(previousId) : undefined;
  if (previousId && !previous) {
    throw new HttpError(404, "The previous_response_id is unknown or expired.", "invalid_request_error", "previous_response_id");
  }

  const newMessages = request.input === undefined ? [] : inputItems(request.input);
  if (!previous && newMessages.length === 0) {
    throw new HttpError(400, "`input` is required unless previous_response_id supplies a conversation.", "invalid_request_error", "input");
  }
  const instructionMessages = responseInstructionMessages(request.instructions);
  const conversationMessages: ChatMessage[] = [
    ...(previous?.messages ?? []),
    ...newMessages,
  ];
  const history: ChatMessage[] = [
    ...instructionMessages,
    ...(previous?.messages ?? []),
    ...newMessages,
  ];
  // Responses `instructions` and `tools` are request-scoped. Clients must send
  // them again on a previous_response_id continuation when they are needed.
  const tools = request.tools === undefined ? [] : responseTools(request.tools);
  const reasoningEffort = responseReasoningEffort(request.reasoning, request.reasoning_effort);
  const responseFormat = responseFormatFromText(request.text);
  if (request.model !== undefined && (typeof request.model !== "string" || !request.model.trim() || request.model.length > 200)) {
    throw new HttpError(400, "`model` must be a non-empty string.", "invalid_request_error", "model");
  }
  const model = typeof request.model === "string" ? request.model.trim() : previous?.model;
  if (!model) {
    throw new HttpError(400, "`model` is required for a new Responses request.", "invalid_request_error", "model");
  }
  const historyLimit = Math.min(
    getProxyConfig().maxResponseHistoryBytes,
    getProxyConfig().maxResponseStateBytes,
  );
  const historyBytes = Buffer.byteLength(JSON.stringify({ model, messages: history, tools }), "utf8");
  const stateReserve = responseStateReserve(request, historyLimit);
  if (historyBytes > historyLimit - stateReserve) {
    throw new HttpError(
      400,
      stateReserve > 0
        ? "The Responses conversation leaves insufficient storage budget for model output."
        : "The Responses conversation exceeds the configured state limit.",
      "invalid_request_error",
      "input",
    );
  }
  const chatRequest: JsonObject = {
    ...request,
    ...(model ? { model } : {}),
    messages: history as unknown as JsonValue,
    tools: tools as unknown as JsonValue,
    tool_choice: responseToolChoice(request.tool_choice),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(request.max_output_tokens !== undefined ? { max_completion_tokens: request.max_output_tokens } : {}),
    stream: false,
  };
  delete chatRequest.input;
  delete chatRequest.instructions;
  delete chatRequest.previous_response_id;

  const execution = await executeChatRequest(chatRequest, {
    stickyKey: previousId ?? responseStickyKey(request.user),
    requiredAccountId: previous?.accountId,
  });
  const id = `resp_${randomUUID().replaceAll("-", "")}`;
  const responseStatus = execution.finishReason === "length" ? "incomplete" : "completed";
  const createdAt = Math.floor(Date.now() / 1_000);
  const output = responseOutput(execution.message, responseStatus);
  const text = execution.message.tool_calls?.length ? "" : outputToText(execution.message.content);
  const response: JsonObject = {
    id,
    object: "response",
    created_at: createdAt,
    status: responseStatus,
    model: execution.model,
    output,
    output_text: text,
    usage: responseUsage(execution.completion.usage as unknown as Record<string, unknown> | undefined),
    ...responseEnvelopeFields(
      request,
      tools,
      previousId,
      responseStatus,
      createdAt,
      responseStatus === "incomplete" ? "max_output_tokens" : undefined,
    ),
  };
  const state: ResponseState = {
    id,
    createdAt: Date.now(),
    accountId: execution.account.id,
    model: execution.model,
    messages: [...conversationMessages, execution.message],
    tools,
  };
  if (request.store !== false) {
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > historyLimit) {
      throw new ProxyRequestError(
        new HttpError(413, "The completed Responses state exceeds the configured storage limit.", "server_error"),
        {
          accountId: execution.account.id,
          accountLabel: execution.account.label,
          upstreamRequest: execution.upstreamRequest,
          upstreamResponse: execution.completion as unknown as JsonObject,
        },
      );
    }
    try {
      await stateStore.saveResponseState(state);
    } catch (error) {
      if (error instanceof ResponseStateLimitError) {
        throw new ProxyRequestError(
          new HttpError(413, "The completed Responses state exceeds the aggregate storage limit.", "server_error"),
          {
            accountId: execution.account.id,
            accountLabel: execution.account.label,
            upstreamRequest: execution.upstreamRequest,
            upstreamResponse: execution.completion as unknown as JsonObject,
          },
        );
      }
      throw new ProxyRequestError(error, {
        accountId: execution.account.id,
        accountLabel: execution.account.label,
        upstreamRequest: execution.upstreamRequest,
        upstreamResponse: execution.completion as unknown as JsonObject,
      });
    }
  }

  return {
    response,
    streamEvents: responsesStreamEvents(response),
    accountId: execution.account.id,
    accountLabel: execution.account.label,
    upstreamRequest: execution.upstreamRequest,
    upstreamResponse: execution.completion as unknown as JsonObject,
    ...(execution.toolCallAdapter ? { toolCallAdapter: execution.toolCallAdapter } : {}),
  };
}
