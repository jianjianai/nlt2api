import { randomUUID } from "node:crypto";
import {
  asChatCompletion,
  chatChunksFromUpstreamFrame,
  createChatStreamState,
  finishChatStream,
  type ChatExecution,
} from "~/server/utils/chat-service.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import { normalizeJsonSchema, validateSchemaDefinition } from "~/server/utils/json-schema.ts";
import { HttpError } from "~/server/utils/http.ts";
import { responseStore } from "~/server/utils/response-store.ts";
import { isValidToolCallId, stringifyContent } from "~/server/utils/tool-calls.ts";
import type {
  ChatMessage,
  JsonObject,
  JsonValue,
  ResponseAccessScope,
  NormalizedToolCall,
  ToolDefinition,
  UpstreamUsage,
} from "~/server/utils/types.ts";

const ENCRYPTED_REASONING_PREFIX = "nwenc1.";
const MAX_ENCRYPTED_REASONING_BYTES = 512 * 1024;

export interface ResponseToolFunction {
  kind: "function";
  name: string;
  description?: string;
  parameters?: JsonObject;
  strict?: boolean;
}

export interface ResponseToolCustom {
  kind: "custom";
  name: string;
  description?: string;
  format?: JsonObject;
}

export type ResponseTool = ResponseToolFunction | ResponseToolCustom;

export interface ResponseRequestContext {
  model: string;
  instructions?: string;
  tools: ResponseTool[];
  droppedTools: string[];
  toolChoice?: JsonValue;
  parallelToolCalls: boolean;
  store: boolean;
  previousResponseId?: string;
  reasoning?: JsonObject;
  text?: JsonObject;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  /** Normalized Responses input items (chain resolved), for state persistence. */
  inputItems: JsonObject[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function invalid(message: string, param?: string): HttpError {
  return new HttpError(400, message, "invalid_request_error", param);
}

function encodeEncryptedReasoning(reasoning: { reasoning?: string; reasoning_content?: string }): string | undefined {
  if (!reasoning.reasoning && !reasoning.reasoning_content) {
    return undefined;
  }
  const serialized = JSON.stringify({
    ...(reasoning.reasoning ? { reasoning: reasoning.reasoning } : {}),
    ...(reasoning.reasoning_content ? { reasoning_content: reasoning.reasoning_content } : {}),
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_ENCRYPTED_REASONING_BYTES) {
    return undefined;
  }
  return `${ENCRYPTED_REASONING_PREFIX}${Buffer.from(serialized, "utf8").toString("base64url")}`;
}

function decodeEncryptedReasoning(value: unknown): { reasoning?: string; reasoning_content?: string } | undefined {
  if (typeof value !== "string" || !value.startsWith(ENCRYPTED_REASONING_PREFIX)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(ENCRYPTED_REASONING_PREFIX.length), "base64url").toString("utf8"));
    const record = asRecord(parsed);
    if (!record) {
      return undefined;
    }
    const reasoning = asStringValue(record.reasoning);
    const reasoningContent = asStringValue(record.reasoning_content);
    return reasoning || reasoningContent
      ? { ...(reasoning ? { reasoning } : {}), ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function reasoningFromItem(item: Record<string, unknown>): { reasoning?: string; reasoning_content?: string } | undefined {
  const decoded = decodeEncryptedReasoning(item.encrypted_content);
  if (decoded) {
    return decoded;
  }
  // A client that echoes reasoning items without encrypted content still
  // carries the visible summary text; keep it as the reasoning field so the
  // upstream retains the model's earlier thinking.
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const text = summary
    .map((part) => asStringValue(asRecord(part)?.text))
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return text ? { reasoning: text } : undefined;
}

function messageContentFromParts(item: Record<string, unknown>, role: string, index: number): { content?: JsonValue; refusal?: string } {
  const content = item.content;
  if (typeof content === "string") {
    return { content };
  }
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) {
      return {};
    }
    throw invalid(`input[${index}].content must be a string or an array of content parts.`, "input");
  }
  const parts: JsonValue[] = [];
  let refusal = "";
  for (const rawPart of content) {
    const part = asRecord(rawPart);
    if (!part) {
      continue;
    }
    const type = asStringValue(part.type);
    if (type === "input_text" || type === "output_text") {
      const text = asStringValue(part.text);
      if (text !== undefined) {
        parts.push({ type: "text", text } as unknown as JsonValue);
      }
    } else if (type === "input_image") {
      const imageUrl = asStringValue(part.image_url);
      if (imageUrl) {
        parts.push({ type: "image_url", image_url: { url: imageUrl } } as unknown as JsonValue);
      }
    } else if (type === "refusal") {
      refusal += asStringValue(part.refusal) ?? "";
    }
    // Unknown content part types are skipped rather than failing the turn.
  }
  const textOnly = parts.every((part) => asRecord(part)?.type === "text");
  const flattened = textOnly
    ? parts.map((part) => asStringValue(asRecord(part)?.text) ?? "").join("\n")
    : parts;
  if (role === "assistant" && flattened.length === 0 && !refusal) {
    return {};
  }
  return {
    ...(flattened.length > 0 || parts.length > 0 ? { content: flattened as JsonValue } : {}),
    ...(refusal ? { refusal } : {}),
  };
}

function toolCallFromItem(item: Record<string, unknown>, customTools: Set<string>, index: number): NormalizedToolCall {
  const callId = asStringValue(item.call_id);
  const name = asStringValue(item.name);
  if (!isValidToolCallId(callId)) {
    throw invalid(`input[${index}].call_id must be a valid tool-call ID.`, "input");
  }
  if (!name) {
    throw invalid(`input[${index}].name is required for a function call item.`, "input");
  }
  // A client may echo a call with an explicit namespace prefix even for the
  // default namespace (for example `functions.exec`); fall back to the plain
  // name when matching custom tools.
  const plainName = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  if (item.type === "custom_tool_call" || customTools.has(name) || customTools.has(plainName)) {
    const input = asStringValue(item.input) ?? asStringValue(item.arguments) ?? "";
    return { id: callId, type: "function", function: { name, arguments: JSON.stringify({ input }) } };
  }
  const argumentsValue = item.arguments;
  const serialized = typeof argumentsValue === "string"
    ? argumentsValue
    : argumentsValue === undefined
      ? "{}"
      : JSON.stringify(argumentsValue);
  return { id: callId, type: "function", function: { name, arguments: serialized } };
}

function toolOutputText(item: Record<string, unknown>): string {
  const output = item.output;
  if (typeof output === "string") {
    return output;
  }
  const record = asRecord(output);
  if (record) {
    const content = record.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => asStringValue(asRecord(part)?.text))
        .filter((value): value is string => Boolean(value))
        .join("\n");
    }
  }
  return JSON.stringify(output ?? "");
}

/**
 * Convert normalized Responses input items into chat messages. Consecutive
 * function/custom tool calls are grouped into one assistant message, and a
 * preceding reasoning item is attached to that assistant turn so the upstream
 * sees the same reasoning fields the chat endpoint would forward.
 */
export function messagesFromResponseItems(items: JsonObject[], customTools: Set<string>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingReasoning: { reasoning?: string; reasoning_content?: string } | undefined;

  const takeReasoning = (): Pick<ChatMessage, "reasoning" | "reasoning_content"> => {
    const current = pendingReasoning ?? {};
    pendingReasoning = undefined;
    return current;
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = asRecord(items[index]);
    if (!item) {
      throw invalid(`input[${index}] must be an item object.`, "input");
    }
    const type = asStringValue(item.type) ?? (asStringValue(item.role) ? "message" : undefined);
    if (type === "reasoning") {
      const reasoning = reasoningFromItem(item);
      if (reasoning) {
        pendingReasoning = {
          reasoning: `${pendingReasoning?.reasoning ?? ""}${reasoning.reasoning ?? ""}` || undefined,
          reasoning_content: `${pendingReasoning?.reasoning_content ?? ""}${reasoning.reasoning_content ?? ""}` || undefined,
        };
      }
      continue;
    }
    if (type === "message") {
      const role = asStringValue(item.role);
      if (!role || !["system", "developer", "user", "assistant"].includes(role)) {
        throw invalid(`input[${index}] has an unsupported message role.`, "input");
      }
      const { content, refusal } = messageContentFromParts(item, role, index);
      const message: ChatMessage = {
        role: role as ChatMessage["role"],
        ...(content !== undefined ? { content } : { content: "" }),
        ...(refusal ? { refusal } : {}),
        ...(role === "assistant" ? takeReasoning() : {}),
      };
      messages.push(message);
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const call = toolCallFromItem(item, customTools, index);
      const reasoning = takeReasoning();
      const previous = messages[messages.length - 1];
      // A message item carrying the assistant's narration followed by
      // function_call items is ONE turn: attach the call to that message so
      // its text becomes the tool-call envelope's preamble when the history
      // is re-encoded for the DeepInfra. Splitting them apart would mis-mark
      // the text as a <|FINAL_REPLY|> message and teach the model to
      // announce instead of calling tools.
      if (previous?.role === "assistant") {
        previous.tool_calls = [...(previous.tool_calls ?? []), call];
        if (reasoning.reasoning) {
          previous.reasoning = `${previous.reasoning ?? ""}${reasoning.reasoning}`;
        }
        if (reasoning.reasoning_content) {
          previous.reasoning_content = `${previous.reasoning_content ?? ""}${reasoning.reasoning_content}`;
        }
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call], ...reasoning });
      }
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = asStringValue(item.call_id);
      if (!isValidToolCallId(callId)) {
        throw invalid(`input[${index}].call_id must be a valid tool-call ID.`, "input");
      }
      messages.push({ role: "tool", tool_call_id: callId, content: toolOutputText(item) });
      continue;
    }
    if (type === "item_reference") {
      throw invalid("`item_reference` input items are not supported; send the referenced items explicitly.", "input");
    }
    // Hosted tool outputs (web_search_call, file_search_call, ...) carry no
    // conversation content the upstream needs; skip them.
  }
  return messages;
}

// Namespaced tools are invoked by dotted wire names (`collaboration.spawn_agent`).
// The `functions` namespace is the default recipient namespace, so its members
// keep their plain names.
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_TOOL_NAMESPACE = "functions";

interface ParsedResponseTools {
  tools: ResponseTool[];
  chatTools: ToolDefinition[];
  dropped: string[];
}

function flattenResponseTools(
  entries: unknown[],
  prefix: string,
  into: { tools: ResponseTool[]; names: Set<string>; dropped: string[] },
  location: string,
): void {
  for (let index = 0; index < entries.length; index += 1) {
    const tool = asRecord(entries[index]);
    const type = asStringValue(tool?.type);
    const at = `${location}[${index}]`;
    if (type === "namespace") {
      const namespaceName = asStringValue(tool?.name);
      const members = Array.isArray(tool?.tools) ? tool.tools : [];
      if (!namespaceName || !TOOL_NAME_PATTERN.test(namespaceName)) {
        throw invalid(`${at} must be a namespace with a valid name.`, "tools");
      }
      const childPrefix = namespaceName === DEFAULT_TOOL_NAMESPACE ? prefix : `${prefix}${namespaceName}.`;
      flattenResponseTools(members, childPrefix, into, `${at}.tools`);
      continue;
    }
    if (type === "function" || type === "custom") {
      const rawName = asStringValue(tool?.name);
      const name = rawName ? `${prefix}${rawName}` : undefined;
      if (!name || !TOOL_NAME_PATTERN.test(name) || (rawName?.includes(".") && prefix)) {
        throw invalid(`${at} must be a ${type} definition with a valid name.`, "tools");
      }
      if (into.names.has(name)) {
        throw invalid(`Tool name \`${name}\` is duplicated.`, "tools");
      }
      into.names.add(name);
      if (type === "function") {
        const parameters = tool?.parameters === undefined ? undefined : asRecord(tool.parameters);
        if (tool?.parameters !== undefined && !parameters) {
          throw invalid(`${at}.parameters must be a JSON Schema object.`, "tools");
        }
        const normalizedParameters = parameters ? normalizeJsonSchema(parameters as JsonObject) : undefined;
        if (normalizedParameters) {
          const schema = validateSchemaDefinition(normalizedParameters);
          if (!schema.valid) {
            throw invalid(`${at}.parameters is invalid: ${schema.errors.join("; ")}`, "tools");
          }
        }
        into.tools.push({
          kind: "function",
          name,
          ...(typeof tool?.description === "string" ? { description: tool.description } : {}),
          ...(normalizedParameters ? { parameters: normalizedParameters } : {}),
          ...(typeof tool?.strict === "boolean" ? { strict: tool.strict } : {}),
        });
      } else {
        into.tools.push({
          kind: "custom",
          name,
          ...(typeof tool?.description === "string" ? { description: tool.description } : {}),
          ...(asRecord(tool?.format) ? { format: asRecord(tool?.format) as JsonObject } : {}),
        });
      }
      continue;
    }
    throw invalid(`${at} uses unsupported tool type \`${type ?? "unknown"}\`; this DeepInfra route supports function tools only.`, "tools");
  }
}

function toChatTools(tools: ResponseTool[]): ToolDefinition[] {
  return tools.map((tool) => tool.kind === "function"
    ? {
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }
    : {
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "The complete free-form tool input." } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    });
}

function parseResponseTools(value: unknown): ParsedResponseTools {
  if (value === undefined || value === null) {
    return { tools: [], chatTools: [], dropped: [] };
  }
  if (!Array.isArray(value)) {
    throw invalid("`tools` must be an array of tool definitions.", "tools");
  }
  const into = { tools: [] as ResponseTool[], names: new Set<string>(), dropped: [] as string[] };
  flattenResponseTools(value, "", into, "tools");
  return { tools: into.tools, chatTools: toChatTools(into.tools), dropped: into.dropped };
}

/**
 * Codex-style clients may carry tool declarations inside the input list:
 * `additional_tools` items hold a `tools` array, and `namespace` items appear
 * as top-level input entries. Harvest both into the effective tool set.
 */
function harvestInputTools(items: JsonObject[], existing: ParsedResponseTools): ParsedResponseTools {
  const into = {
    tools: [...existing.tools],
    names: new Set(existing.tools.map((tool) => tool.name)),
    dropped: [...existing.dropped],
  };
  for (let index = 0; index < items.length; index += 1) {
    const item = asRecord(items[index]);
    const type = asStringValue(item?.type);
    if (type === "additional_tools") {
      const tools = item?.tools;
      if (tools !== undefined && !Array.isArray(tools)) {
        throw invalid(`input[${index}].tools must be an array of tool definitions.`, "input");
      }
      flattenResponseTools(Array.isArray(tools) ? tools : [], "", into, `input[${index}].tools`);
      continue;
    }
    if (type === "namespace") {
      flattenResponseTools([item], "", into, "input");
    }
  }
  return { tools: into.tools, chatTools: toChatTools(into.tools), dropped: into.dropped };
}

function parseResponseToolChoice(value: unknown, tools: ResponseTool[] | undefined): JsonValue | undefined {
  if (value === undefined || value === null || value === "auto" || value === "none" || value === "required") {
    return value === null ? undefined : value as JsonValue;
  }
  const choice = asRecord(value);
  const type = asStringValue(choice?.type);
  if ((type === "function" || type === "custom") && typeof choice?.name === "string") {
    // Membership is checked in a second phase once input-carried tool
    // declarations have been harvested; the first call passes no tool list.
    if (tools && !tools.some((tool) => tool.name === choice.name)) {
      throw invalid("`tool_choice` must reference one of the supplied tools.", "tool_choice");
    }
    return { type: "function", function: { name: choice.name } } as unknown as JsonValue;
  }
  throw invalid("`tool_choice` must be \"auto\", \"none\", \"required\", or a named function tool.", "tool_choice");
}

function parseResponseReasoning(value: unknown): { reasoning?: JsonObject; effort?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  const reasoning = asRecord(value);
  if (!reasoning) {
    throw invalid("`reasoning` must be an object.", "reasoning");
  }
  const effort = reasoning.effort;
  if (effort !== undefined && effort !== null && typeof effort !== "string") {
    throw invalid("`reasoning.effort` must be a string.", "reasoning");
  }
  return {
    reasoning: reasoning as JsonObject,
    ...(typeof effort === "string" && effort ? { effort } : {}),
  };
}

function parseTextFormat(value: unknown): { text?: JsonObject; responseFormat?: JsonValue } {
  if (value === undefined || value === null) {
    return {};
  }
  const text = asRecord(value);
  if (!text) {
    throw invalid("`text` must be an object.", "text");
  }
  const format = asRecord(text.format);
  const formatType = asStringValue(format?.type);
  if (!format || formatType === "text") {
    return { text: text as JsonObject };
  }
  if (formatType === "json_object") {
    return { text: text as JsonObject, responseFormat: { type: "json_object" } as unknown as JsonValue };
  }
  if (formatType === "json_schema") {
    return {
      text: text as JsonObject,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: asStringValue(format.name) ?? "response",
          ...(format.schema ? { schema: format.schema } : {}),
          ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
          ...(typeof format.description === "string" ? { description: format.description } : {}),
        },
      } as unknown as JsonValue,
    };
  }
  throw invalid("`text.format.type` must be \"text\", \"json_object\", or \"json_schema\".", "text");
}

function normalizeInputItems(input: unknown): JsonObject[] {
  if (typeof input === "string") {
    if (!input.trim()) {
      throw invalid("`input` must not be empty.", "input");
    }
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (!Array.isArray(input)) {
    throw invalid("`input` must be a string or an array of input items.", "input");
  }
  const maxItems = getProxyConfig().maxResponseItems;
  if (input.length > maxItems) {
    // 413, not 400: the request is well-formed but exceeds a server payload
    // limit, matching the body-size handling in http.ts.
    throw new HttpError(413, `\`input\` exceeds the supported item limit (limit ${maxItems} items; raise DEEPINFRA_GATEWAY_MAX_RESPONSE_ITEMS).`, "invalid_request_error", "input");
  }
  return input.map((item, index) => {
    const record = asRecord(item);
    if (!record) {
      throw invalid(`input[${index}] must be an item object.`, "input");
    }
    return record as JsonObject;
  });
}

export interface ValidatedResponseRequest {
  chatRequest: JsonObject;
  context: ResponseRequestContext;
}

/**
 * Validate a Responses API request and convert it into the equivalent chat
 * request so execution, tool-call adaptation, and repair behave identically
 * to `/v1/chat/completions`.
 */
export async function validateResponseRequest(
  body: JsonObject,
  access: ResponseAccessScope = { scope: "global" },
): Promise<ValidatedResponseRequest> {
  const model = body.model;
  if (model !== undefined && model !== null && (typeof model !== "string" || model.length > 200)) {
    throw invalid("`model` must be a string.", "model");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalid("`stream` must be a boolean.", "stream");
  }
  const instructions = body.instructions;
  if (instructions !== undefined && instructions !== null && typeof instructions !== "string") {
    throw invalid("`instructions` must be a string.", "instructions");
  }
  const store = body.store === undefined ? true : body.store;
  if (typeof store !== "boolean") {
    throw invalid("`store` must be a boolean.", "store");
  }
  const previousResponseId = body.previous_response_id;
  if (previousResponseId !== undefined && previousResponseId !== null && typeof previousResponseId !== "string") {
    throw invalid("`previous_response_id` must be a string.", "previous_response_id");
  }


  const { reasoning, effort } = parseResponseReasoning(body.reasoning);
  const { text, responseFormat } = parseTextFormat(body.text);
  const parallelToolCalls = body.parallel_tool_calls === undefined ? true : body.parallel_tool_calls;
  if (typeof parallelToolCalls !== "boolean") {
    throw invalid("`parallel_tool_calls` must be a boolean.", "parallel_tool_calls");
  }
  const maxOutputTokens = body.max_output_tokens;
  if (maxOutputTokens !== undefined && maxOutputTokens !== null
    && (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) {
    throw invalid("`max_output_tokens` must be a positive integer.", "max_output_tokens");
  }

  let inputItems = normalizeInputItems(body.input ?? []);
  let chainModel: string | undefined;
  if (typeof previousResponseId === "string" && previousResponseId) {
    const stored = await responseStore.get(previousResponseId);
    const allowed = stored && (access.scope === "global"
      || (stored.access.scope === "group" && stored.access.groupId === access.groupId));
    if (!allowed) {
      throw new HttpError(400, `Previous response with id '${previousResponseId}' not found.`, "invalid_request_error", "previous_response_id");
    }
    inputItems = [...stored.items, ...inputItems];
    chainModel = stored.model;
  }
  const { tools, chatTools } = harvestInputTools(inputItems, parseResponseTools(body.tools));
  const toolChoice = parseResponseToolChoice(body.tool_choice, tools);
  if (inputItems.length === 0) {
    throw invalid("`input` must not be empty.", "input");
  }
  const historyBytes = Buffer.byteLength(JSON.stringify(inputItems), "utf8");
  if (historyBytes > getProxyConfig().maxResponseHistoryBytes) {
    throw invalid(`The reconstructed response history exceeds the supported size (limit ${getProxyConfig().maxResponseHistoryBytes} bytes; raise DEEPINFRA_GATEWAY_MAX_RESPONSE_HISTORY_BYTES).`, "input");
  }

  const customTools = new Set(tools.filter((tool) => tool.kind === "custom").map((tool) => tool.name));
  const messages = messagesFromResponseItems(inputItems, customTools);
  if (typeof instructions === "string" && instructions.trim()) {
    messages.unshift({ role: "system", content: instructions });
  }
  if (!messages.some((message) => message.role !== "system" && message.role !== "developer")) {
    throw invalid("`input` must contain at least one user, assistant, or tool item.", "input");
  }

  const chatRequest: JsonObject = {
    model: typeof model === "string" && model ? model : chainModel ?? getProxyConfig().defaultModel,
    messages: messages as unknown as JsonValue,
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(chatTools.length > 0 ? { tools: chatTools as unknown as JsonValue } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    parallel_tool_calls: parallelToolCalls,
    ...(typeof maxOutputTokens === "number" ? { max_completion_tokens: maxOutputTokens } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(typeof body.prompt_cache_key === "string" && body.prompt_cache_key
      ? { user: body.prompt_cache_key.slice(0, 256) }
      : typeof previousResponseId === "string" && previousResponseId
        ? { user: `response:${previousResponseId}`.slice(0, 256) }
        : {}),
  };

  return {
    chatRequest,
    context: {
      model: chatRequest.model as string,
      ...(typeof instructions === "string" ? { instructions } : {}),
      tools,
      droppedTools: [],
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      parallelToolCalls,
      store,
      ...(typeof previousResponseId === "string" && previousResponseId ? { previousResponseId } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(text ? { text } : {}),
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(typeof body.top_p === "number" ? { topP: body.top_p } : {}),
      ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}),
      inputItems,
    },
  };
}

function responseUsage(usage: UpstreamUsage | undefined): JsonObject | undefined {
  if (!usage) {
    return undefined;
  }
  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const cached = typeof usage.prompt_tokens_details?.cached_tokens === "number"
    ? usage.prompt_tokens_details.cached_tokens
    : 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : input + output,
  };
}

function responseToolShape(tool: ResponseTool): JsonObject {
  return tool.kind === "function"
    ? {
      type: "function",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    }
    : {
      type: "custom",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.format ? { format: tool.format } : {}),
    };
}

export interface ResponseOutputItems {
  items: JsonObject[];
  messageItem?: JsonObject;
  functionCallItems: JsonObject[];
  reasoningItem?: JsonObject;
}

/** Build the Responses output items for a finished execution. */
export function responseOutputItems(
  execution: ChatExecution,
  context: ResponseRequestContext,
  ids?: { reasoningId?: string; messageId?: string },
): ResponseOutputItems {
  const items: JsonObject[] = [];
  const customTools = new Set(context.tools.filter((tool) => tool.kind === "custom").map((tool) => tool.name));
  let reasoningItem: JsonObject | undefined;
  const reasoning = typeof execution.message.reasoning === "string" ? execution.message.reasoning : "";
  const reasoningContent = typeof execution.message.reasoning_content === "string" ? execution.message.reasoning_content : "";
  const reasoningText = [reasoning, reasoningContent].filter(Boolean).join("\n");
  if (reasoningText) {
    const encrypted = encodeEncryptedReasoning({
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    });
    reasoningItem = {
      id: ids?.reasoningId ?? `rs_${randomUUID().replaceAll("-", "")}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: reasoningText }],
      ...(encrypted ? { encrypted_content: encrypted } : {}),
    };
    items.push(reasoningItem);
  }

  let messageItem: JsonObject | undefined;
  const content = typeof execution.message.content === "string" ? execution.message.content : "";
  const refusal = typeof execution.message.refusal === "string" ? execution.message.refusal : "";
  if (content || refusal || !execution.message.tool_calls?.length) {
    const parts: JsonObject[] = [];
    if (content || !refusal) {
      parts.push({ type: "output_text", text: content, annotations: [] });
    }
    if (refusal) {
      parts.push({ type: "refusal", refusal });
    }
    messageItem = {
      id: ids?.messageId ?? `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: parts,
    };
    items.push(messageItem);
  }

  const functionCallItems: JsonObject[] = [];
  for (const call of execution.message.tool_calls ?? []) {
    if (customTools.has(call.function.name)) {
      let input = call.function.arguments;
      try {
        const parsed = asRecord(JSON.parse(call.function.arguments));
        if (parsed && typeof parsed.input === "string") {
          input = parsed.input;
        }
      } catch {
        // Keep the raw arguments string when it is not wrapped JSON.
      }
      const item = {
        id: `ctc_${randomUUID().replaceAll("-", "")}`,
        type: "custom_tool_call",
        status: "completed",
        call_id: call.id,
        name: call.function.name,
        input,
      };
      functionCallItems.push(item);
      items.push(item);
      continue;
    }
    const item = {
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    };
    functionCallItems.push(item);
    items.push(item);
  }

  return { items, ...(messageItem ? { messageItem } : {}), functionCallItems, ...(reasoningItem ? { reasoningItem } : {}) };
}

/** Assemble the full Responses API object from prebuilt output items. */
export function responseObject(
  execution: ChatExecution,
  context: ResponseRequestContext,
  id: string,
  createdAt: number,
  items: JsonObject[],
): JsonObject {
  const incomplete = execution.finishReason === "length";
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: incomplete ? "incomplete" : "completed",
    background: false,
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    instructions: context.instructions ?? null,
    max_output_tokens: context.maxOutputTokens ?? null,
    model: execution.model,
    output: items as unknown as JsonValue,
    parallel_tool_calls: context.parallelToolCalls,
    previous_response_id: context.previousResponseId ?? null,
    reasoning: context.reasoning ?? { effort: null, summary: null },
    store: context.store,
    temperature: context.temperature ?? null,
    text: context.text ?? { format: { type: "text" } },
    tool_choice: context.toolChoice ?? "auto",
    tools: context.tools.map(responseToolShape) as unknown as JsonValue,
    top_p: context.topP ?? null,
    metadata: {},
    usage: responseUsage(execution.completion.usage) ?? null,
    ...(execution.completion.energy ? { energy: execution.completion.energy as unknown as JsonValue } : {}),
    ...(execution.completion.cost ? { cost: execution.completion.cost as unknown as JsonValue } : {}),
    ...(execution.completion.service_tier ? { service_tier: execution.completion.service_tier } : {}),
  };
}

/** Assemble the full Responses API object for a finished execution. */
export function responseFromExecution(
  execution: ChatExecution,
  context: ResponseRequestContext,
  id: string,
  createdAt: number,
): JsonObject {
  const { items } = responseOutputItems(execution, context);
  return responseObject(execution, context, id, createdAt, items);
}

/** Persist the chain link for a stored response so later turns can reference it. */
export async function persistResponseState(
  id: string,
  execution: ChatExecution,
  context: ResponseRequestContext,
  access: ResponseAccessScope = { scope: "global" },
): Promise<void> {
  if (!context.store) {
    return;
  }
  try {
    const { items } = responseOutputItems(execution, context);
    await responseStore.save({
      id,
      createdAt: new Date().toISOString(),
      access,
      model: execution.model,
      ...(context.previousResponseId ? { previousResponseId: context.previousResponseId } : {}),
      items: [...context.inputItems, ...items],
    });
  } catch {
    // State persistence is an optimization; never fail a completed response.
  }
}

export interface ResponseStreamState {
  id: string;
  createdAt: number;
  context: ResponseRequestContext;
  sequence: number;
  outputIndex: number;
  reasoningItemId?: string;
  reasoningOpen: boolean;
  reasoningText: string;
  messageItemId?: string;
  messageOpen: boolean;
  messageText: string;
  openPartType?: "output_text" | "refusal";
  textPartOpened: boolean;
  refusalPartOpened: boolean;
  refusalText: string;
  usage?: JsonObject;
  completed: boolean;
}

export function createResponseStreamState(context: ResponseRequestContext): ResponseStreamState {
  return {
    id: `resp_${randomUUID().replaceAll("-", "")}`,
    createdAt: Math.floor(Date.now() / 1_000),
    context,
    sequence: 0,
    outputIndex: 0,
    reasoningOpen: false,
    reasoningText: "",
    messageOpen: false,
    messageText: "",
    textPartOpened: false,
    refusalPartOpened: false,
    refusalText: "",
    completed: false,
  };
}

export interface ResponseStreamEvent {
  event: string;
  data: JsonObject;
}

function streamEvent(state: ResponseStreamState, event: string, data: JsonObject): ResponseStreamEvent {
  state.sequence += 1;
  return { event, data: { ...data, sequence_number: state.sequence } };
}

function inProgressResponse(state: ResponseStreamState): JsonObject {
  return {
    id: state.id,
    object: "response",
    created_at: state.createdAt,
    status: "in_progress",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: state.context.instructions ?? null,
    max_output_tokens: state.context.maxOutputTokens ?? null,
    model: state.context.model,
    output: [],
    parallel_tool_calls: state.context.parallelToolCalls,
    previous_response_id: state.context.previousResponseId ?? null,
    reasoning: state.context.reasoning ?? { effort: null, summary: null },
    store: state.context.store,
    temperature: state.context.temperature ?? null,
    text: state.context.text ?? { format: { type: "text" } },
    tool_choice: state.context.toolChoice ?? "auto",
    tools: state.context.tools.map(responseToolShape) as unknown as JsonValue,
    top_p: state.context.topP ?? null,
    metadata: {},
    usage: null,
  };
}

/** The initial events every Responses stream opens with. */
export function startResponseStream(state: ResponseStreamState): ResponseStreamEvent[] {
  return [
    streamEvent(state, "response.created", { type: "response.created", response: inProgressResponse(state) }),
    streamEvent(state, "response.in_progress", { type: "response.in_progress", response: inProgressResponse(state) }),
  ];
}

function openReasoningItem(state: ResponseStreamState): ResponseStreamEvent[] {
  if (state.reasoningOpen) {
    return [];
  }
  state.reasoningOpen = true;
  state.reasoningItemId = `rs_${randomUUID().replaceAll("-", "")}`;
  const item: JsonObject = {
    id: state.reasoningItemId,
    type: "reasoning",
    summary: [],
  };
  return [
    streamEvent(state, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item,
    }),
    streamEvent(state, "response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningItemId,
      output_index: state.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
  ];
}

function closeReasoningItem(state: ResponseStreamState): ResponseStreamEvent[] {
  if (!state.reasoningOpen) {
    return [];
  }
  state.reasoningOpen = false;
  const itemId = state.reasoningItemId!;
  const item: JsonObject = {
    id: itemId,
    type: "reasoning",
    summary: [{ type: "summary_text", text: state.reasoningText }],
  };
  const events = [
    streamEvent(state, "response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: itemId,
      output_index: state.outputIndex,
      summary_index: 0,
      text: state.reasoningText,
    }),
    streamEvent(state, "response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: itemId,
      output_index: state.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: state.reasoningText },
    }),
    streamEvent(state, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.outputIndex,
      item,
    }),
  ];
  state.outputIndex += 1;
  return events;
}

function closeOpenPart(state: ResponseStreamState): ResponseStreamEvent[] {
  if (!state.messageOpen || !state.openPartType) {
    return [];
  }
  const itemId = state.messageItemId!;
  const partType = state.openPartType;
  state.openPartType = undefined;
  const contentIndex = partType === "refusal" && state.textPartOpened ? 1 : 0;
  if (partType === "refusal") {
    return [
      streamEvent(state, "response.refusal.done", {
        type: "response.refusal.done",
        item_id: itemId,
        output_index: state.outputIndex,
        content_index: contentIndex,
        refusal: state.refusalText,
      }),
      streamEvent(state, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: state.outputIndex,
        content_index: contentIndex,
        part: { type: "refusal", refusal: state.refusalText },
      }),
    ];
  }
  return [
    streamEvent(state, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: state.outputIndex,
      content_index: 0,
      text: state.messageText,
    }),
    streamEvent(state, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: state.messageText, annotations: [] },
    }),
  ];
}

function openMessageItem(state: ResponseStreamState, partType: "output_text" | "refusal"): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [];
  if (!state.messageOpen) {
    state.messageOpen = true;
    state.messageItemId = `msg_${randomUUID().replaceAll("-", "")}`;
    events.push(streamEvent(state, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item: {
        id: state.messageItemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    }));
  }
  if (state.openPartType === partType) {
    return events;
  }
  events.push(...closeOpenPart(state));
  const contentIndex = partType === "refusal" && state.textPartOpened ? 1 : 0;
  events.push(streamEvent(state, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: state.messageItemId!,
    output_index: state.outputIndex,
    content_index: contentIndex,
    part: partType === "refusal"
      ? { type: "refusal", refusal: "" }
      : { type: "output_text", text: "", annotations: [] },
  }));
  state.openPartType = partType;
  if (partType === "refusal") {
    state.refusalPartOpened = true;
  } else {
    state.textPartOpened = true;
  }
  return events;
}

function closeMessageItem(state: ResponseStreamState): ResponseStreamEvent[] {
  if (!state.messageOpen) {
    return [];
  }
  const events: ResponseStreamEvent[] = closeOpenPart(state);
  state.messageOpen = false;
  const itemId = state.messageItemId!;
  const parts: JsonObject[] = [];
  if (state.textPartOpened) {
    parts.push({ type: "output_text", text: state.messageText, annotations: [] });
  }
  if (state.refusalPartOpened) {
    parts.push({ type: "refusal", refusal: state.refusalText });
  }
  events.push(streamEvent(state, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: state.outputIndex,
    item: {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: parts,
    },
  }));
  state.outputIndex += 1;
  return events;
}

/**
 * Convert one OpenAI chat chunk (produced by the shared chat stream state
 * machine) into Responses API events. Reasoning deltas open a reasoning item;
 * content deltas open a message item; usage frames are stashed for the final
 * `response.completed`.
 */
export function responseEventsFromChatChunk(chunk: JsonObject, state: ResponseStreamState): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [];
  const usage = asRecord(chunk.usage);
  if (usage) {
    state.usage = responseUsage(usage as unknown as UpstreamUsage);
  }
  const choice = Array.isArray(chunk.choices) ? asRecord(chunk.choices[0]) : undefined;
  const delta = asRecord(choice?.delta);
  if (!delta) {
    return events;
  }
  const reasoningDelta = [asStringValue(delta.reasoning), asStringValue(delta.reasoning_content)]
    .filter((value): value is string => Boolean(value))
    .join("");
  if (reasoningDelta) {
    events.push(...openReasoningItem(state));
    state.reasoningText += reasoningDelta;
    events.push(streamEvent(state, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: state.reasoningItemId!,
      output_index: state.outputIndex,
      summary_index: 0,
      delta: reasoningDelta,
    }));
  }
  const contentDelta = asStringValue(delta.content);
  if (contentDelta) {
    events.push(...closeReasoningItem(state));
    events.push(...openMessageItem(state, "output_text"));
    state.messageText += contentDelta;
    events.push(streamEvent(state, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: state.messageItemId!,
      output_index: state.outputIndex,
      content_index: 0,
      delta: contentDelta,
    }));
  }
  const refusalDelta = asStringValue(delta.refusal);
  if (refusalDelta) {
    events.push(...closeReasoningItem(state));
    events.push(...openMessageItem(state, "refusal"));
    state.refusalText += refusalDelta;
    events.push(streamEvent(state, "response.refusal.delta", {
      type: "response.refusal.delta",
      item_id: state.messageItemId!,
      output_index: state.outputIndex,
      content_index: state.textPartOpened ? 1 : 0,
      delta: refusalDelta,
    }));
  }
  return events;
}

function functionCallEvents(state: ResponseStreamState, item: JsonObject): ResponseStreamEvent[] {
  const outputIndex = state.outputIndex;
  state.outputIndex += 1;
  const itemId = item.id as string;
  const isCustom = item.type === "custom_tool_call";
  const payload = isCustom ? asStringValue(item.input) ?? "" : asStringValue(item.arguments) ?? "";
  const deltaEvent = isCustom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta";
  const doneEvent = isCustom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done";
  const payloadField = isCustom ? "input" : "arguments";
  return [
    streamEvent(state, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, status: "in_progress", [payloadField]: "" },
    }),
    streamEvent(state, deltaEvent, {
      type: deltaEvent,
      item_id: itemId,
      output_index: outputIndex,
      delta: payload,
    }),
    streamEvent(state, doneEvent, {
      type: doneEvent,
      item_id: itemId,
      output_index: outputIndex,
      [payloadField]: payload,
    }),
    streamEvent(state, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    }),
  ];
}

/**
 * Close any open items, emit buffered content (tool-turn preambles arrive
 * only after validation, mirroring the chat endpoint), emit the validated
 * function calls, and finish with `response.completed`.
 */
export function finishResponseStream(execution: ChatExecution, state: ResponseStreamState): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [];
  events.push(...closeReasoningItem(state));

  const finalContent = typeof execution.message.content === "string" ? execution.message.content : "";
  if (finalContent && finalContent !== state.messageText) {
    // The buffered tool-turn preamble (or a JSON-fallback answer) was not
    // streamed; release it now as one delta before the terminal events.
    events.push(...openMessageItem(state, "output_text"));
    const delta = finalContent.startsWith(state.messageText)
      ? finalContent.slice(state.messageText.length)
      : finalContent;
    state.messageText = finalContent;
    if (delta) {
      events.push(streamEvent(state, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: state.messageItemId!,
        output_index: state.outputIndex,
        content_index: 0,
        delta,
      }));
    }
  }
  const finalRefusal = typeof execution.message.refusal === "string" ? execution.message.refusal : "";
  if (finalRefusal && finalRefusal !== state.refusalText) {
    events.push(...openMessageItem(state, "refusal"));
    state.refusalText = finalRefusal;
    events.push(streamEvent(state, "response.refusal.delta", {
      type: "response.refusal.delta",
      item_id: state.messageItemId!,
      output_index: state.outputIndex,
      content_index: state.textPartOpened ? 1 : 0,
      delta: finalRefusal,
    }));
  }
  events.push(...closeMessageItem(state));

  const { items, functionCallItems, messageItem } = responseOutputItems(execution, state.context, {
    ...(state.reasoningItemId ? { reasoningId: state.reasoningItemId } : {}),
    ...(state.messageItemId ? { messageId: state.messageItemId } : {}),
  });
  if (messageItem && state.messageItemId === undefined) {
    // The final message item never entered the stream (for example an empty
    // answer on a JSON-fallback turn); emit its full lifecycle now so clients
    // observe every output item as stream events too.
    const outputIndex = state.outputIndex;
    state.outputIndex += 1;
    const itemId = messageItem.id as string;
    const parts = Array.isArray(messageItem.content) ? messageItem.content as JsonObject[] : [];
    events.push(streamEvent(state, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...messageItem, status: "in_progress", content: [] },
    }));
    parts.forEach((part, contentIndex) => {
      const isRefusal = part.type === "refusal";
      events.push(streamEvent(state, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: isRefusal ? { type: "refusal", refusal: "" } : { type: "output_text", text: "", annotations: [] },
      }));
      events.push(streamEvent(state, isRefusal ? "response.refusal.done" : "response.output_text.done", {
        type: isRefusal ? "response.refusal.done" : "response.output_text.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        ...(isRefusal ? { refusal: part.refusal ?? "" } : { text: part.text ?? "" }),
      }));
      events.push(streamEvent(state, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part,
      }));
    });
    events.push(streamEvent(state, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: messageItem,
    }));
  }
  for (const item of functionCallItems) {
    events.push(...functionCallEvents(state, item));
  }

  const response = responseObject(execution, state.context, state.id, state.createdAt, items);
  if (state.usage && !response.usage) {
    response.usage = state.usage;
  }
  state.completed = true;
  events.push(streamEvent(state, "response.completed", {
    type: "response.completed",
    response,
  }));
  return events;
}

/** Terminal event for a stream that failed before completion. */
export function failedResponseEvent(state: ResponseStreamState, error: { code: string; message: string }): ResponseStreamEvent {
  const response = inProgressResponse(state);
  response.status = "failed";
  response.error = { code: error.code, message: error.message };
  return streamEvent(state, "response.failed", {
    type: "response.failed",
    response,
  });
}

/** Re-export the shared chat stream helpers used by the responses route. */
export {
  asChatCompletion,
  chatChunksFromUpstreamFrame,
  createChatStreamState,
  finishChatStream,
};