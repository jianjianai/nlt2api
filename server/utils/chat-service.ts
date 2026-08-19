import { createHash, randomUUID } from "node:crypto";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import { HttpError } from "~/server/utils/http.ts";
import { parseAndValidateToolArguments, validateSchemaDefinition } from "~/server/utils/json-schema.ts";
import { portalClient, PortalError, readPortalJson, retryAfterSeconds } from "~/server/utils/portal-client.ts";
import { ProxyRequestError, type RequestDebugContext } from "~/server/utils/request-errors.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { collectUpstreamStream, UpstreamStreamError, type UpstreamFrameHandler } from "~/server/utils/upstream-stream.ts";
import {
  InvalidStructuredToolCallsError,
  envelopeAllowedForToolChoice,
  normaliseAssistantToolCalls,
  parseControlledToolEnvelopeDetailed,
  withToolCallContract,
} from "~/server/utils/tool-calls.ts";
import type {
  ChatMessage,
  JsonObject,
  JsonValue,
  ManagedAccount,
  NormalizedToolCall,
  ToolCallAdapterTrace,
  ToolDefinition,
  UpstreamCompletion,
} from "~/server/utils/types.ts";

const MAX_TOOLS = 64;
const MAX_TOOL_DEFINITION_BYTES = 256 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const DEFAULT_OUTPUT_TOKENS = 16_384;
// The Playground currently rejects max_tokens above 16,384 even for models
// whose context window is much larger. Keep the public request budget flexible
// while never sending a value the browser endpoint will reject.
const PORTAL_MAX_OUTPUT_TOKENS = 16_384;
const MAX_TOOL_REPAIR_ATTEMPTS = 5;
const MAX_TOOL_REPAIR_CANDIDATE_CHARS = 131_072;

export interface ChatExecution {
  account: ManagedAccount;
  completion: UpstreamCompletion;
  message: ChatMessage;
  finishReason: string;
  model: string;
  tools: ToolDefinition[];
  upstreamRequest: JsonObject;
  toolCallAdapter?: ToolCallAdapterTrace;
}

export class ClientDisconnectedError extends Error {
  constructor() {
    super("The client disconnected before the completion finished.");
    this.name = "ClientDisconnectedError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "`messages` must be a non-empty array.", "invalid_request_error", "messages");
  }
  if (value.length > 1_000) {
    throw new HttpError(400, "`messages` exceeds the supported history limit.", "invalid_request_error", "messages");
  }

  return value.map((raw, index) => {
    const message = asRecord(raw);
    const role = message?.role;
    if (!message || !["system", "developer", "user", "assistant", "tool"].includes(String(role))) {
      throw new HttpError(400, `messages[${index}] has an unsupported role.`, "invalid_request_error", "messages");
    }
    if (role === "tool") {
      if (typeof message.tool_call_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.tool_call_id)) {
        throw new HttpError(400, `messages[${index}].tool_call_id must be a valid tool-call ID.`, "invalid_request_error", "messages");
      }
      const content = message.content;
      const serialized = typeof content === "string" ? content : JSON.stringify(content ?? "");
      if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_RESULT_BYTES) {
        throw new HttpError(400, `messages[${index}].content exceeds the ${MAX_TOOL_RESULT_BYTES} byte tool-result limit.`, "invalid_request_error", "messages");
      }
    }
    return message as ChatMessage;
  });
}

export function parseTools(value: unknown): ToolDefinition[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_TOOLS) {
    throw new HttpError(400, `\`tools\` must contain at most ${MAX_TOOLS} function definitions.`, "invalid_request_error", "tools");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TOOL_DEFINITION_BYTES) {
    throw new HttpError(400, "`tools` exceeds the supported definition size.", "invalid_request_error", "tools");
  }

  const names = new Set<string>();
  return value.map((raw, index) => {
    const tool = asRecord(raw);
    const functionDefinition = asRecord(tool?.function);
    const name = functionDefinition?.name;
    if (tool?.type !== "function" || !functionDefinition || typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new HttpError(400, `tools[${index}] must be an OpenAI function definition with a valid name.`, "invalid_request_error", "tools");
    }
    if (names.has(name)) {
      throw new HttpError(400, `Tool name \`${name}\` is duplicated.`, "invalid_request_error", "tools");
    }
    names.add(name);

    const parameters = functionDefinition.parameters;
    if (parameters !== undefined && (!asRecord(parameters) || Array.isArray(parameters))) {
      throw new HttpError(400, `tools[${index}].function.parameters must be a JSON Schema object.`, "invalid_request_error", "tools");
    }
    if (parameters) {
      const schema = validateSchemaDefinition(parameters as JsonObject);
      if (!schema.valid) {
        throw new HttpError(400, `tools[${index}].function.parameters is invalid: ${schema.errors.join("; ")}`, "invalid_request_error", "tools");
      }
    }
    return {
      type: "function",
      function: {
        name,
        ...(typeof functionDefinition.description === "string" ? { description: functionDefinition.description } : {}),
        ...(parameters ? { parameters: parameters as JsonObject } : {}),
        ...(typeof functionDefinition.strict === "boolean" ? { strict: functionDefinition.strict } : {}),
      },
    };
  });
}

function validateToolChoice(value: unknown, tools: ToolDefinition[]): void {
  if (tools.length === 0 && value !== undefined && value !== "none") {
    throw new HttpError(400, "`tool_choice` requires at least one function in `tools`.", "invalid_request_error", "tool_choice");
  }
  if (value === undefined || value === "auto" || value === "none" || value === "required") {
    return;
  }
  const choice = asRecord(value);
  const functionName = asRecord(choice?.function)?.name;
  if (choice?.type !== "function" || typeof functionName !== "string" || !tools.some((tool) => tool.function.name === functionName)) {
    throw new HttpError(400, "`tool_choice` must reference one of the supplied functions.", "invalid_request_error", "tool_choice");
  }
}

function modelFromRequest(request: JsonObject): string {
  const model = request.model;
  if (model === undefined || model === null || model === "") {
    return getProxyConfig().defaultModel;
  }
  if (typeof model !== "string" || model.length > 200) {
    throw new HttpError(400, "`model` must be a string.", "invalid_request_error", "model");
  }
  return model;
}

function validateTokenLimit(request: JsonObject): number | undefined {
  const raw = request.max_completion_tokens ?? request.max_tokens;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const maxOutputTokens = getProxyConfig().maxOutputTokens;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > maxOutputTokens) {
    throw new HttpError(400, `\`max_tokens\` must be an integer between 1 and ${maxOutputTokens}.`, "invalid_request_error", "max_tokens");
  }
  return raw;
}

function validateSampling(request: JsonObject): void {
  const temperature = request.temperature;
  if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new HttpError(400, "`temperature` must be between 0 and 2.", "invalid_request_error", "temperature");
  }
  const topP = request.top_p;
  if (topP !== undefined && (typeof topP !== "number" || !Number.isFinite(topP) || topP < 0 || topP > 1)) {
    throw new HttpError(400, "`top_p` must be between 0 and 1.", "invalid_request_error", "top_p");
  }
  const stop = request.stop;
  if (stop !== undefined && typeof stop !== "string" && !(Array.isArray(stop) && stop.every((item) => typeof item === "string") && stop.length <= 4)) {
    throw new HttpError(400, "`stop` must be a string or an array of at most four strings.", "invalid_request_error", "stop");
  }
}

export function validateChatRequest(request: JsonObject): void {
  const model = modelFromRequest(request);
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw new HttpError(400, "`stream` must be a boolean.", "invalid_request_error", "stream");
  }
  validateSampling(request);
  const tools = parseTools(request.tools);
  const messages = parseMessages(request.messages);
  validateToolChoice(request.tool_choice, tools);
  if (request.n !== undefined && request.n !== 1) {
    throw new HttpError(400, "Only n=1 is supported by the portal adapter.", "invalid_request_error", "n");
  }
  upstreamBody(request, model, messages, tools, false);
}

function portalMessages(messages: ChatMessage[]): ChatMessage[] {
  // The Playground currently rejects the OpenAI `developer` role. Preserve
  // message order and content while sending its closest supported role.
  return messages.map((message) => message.role === "developer"
    ? { ...message, role: "system" }
    : message);
}

function upstreamBody(
  request: JsonObject,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  stream: boolean,
): JsonObject {
  const tokenLimit = validateTokenLimit(request);
  const toolChoice = request.tool_choice;
  const toolTurn = tools.length > 0 && toolChoice !== "none";
  const parallelToolCalls = request.parallel_tool_calls === undefined ? true : request.parallel_tool_calls;
  if (typeof parallelToolCalls !== "boolean") {
    throw new HttpError(400, "`parallel_tool_calls` must be a boolean.", "invalid_request_error", "parallel_tool_calls");
  }
  const accepted = [
    "temperature",
    "top_p",
    "stop",
    "seed",
    "reasoning_effort",
    "thinking_token_budget",
    "chat_template_kwargs",
    "parallel_tool_calls",
  ];
  const upstreamMessages = portalMessages(messages);
  const body: JsonObject = {
    model,
    messages: (toolTurn
      ? withToolCallContract(upstreamMessages, tools, toolChoice, parallelToolCalls)
      : upstreamMessages) as unknown as JsonValue,
    stream,
  };
  for (const field of accepted) {
    if (request[field] !== undefined) {
      body[field] = request[field];
    }
  }
  // The Playground otherwise applies its conversational sampling default.
  // Tool turns are protocol work, so use deterministic sampling unless the
  // OpenAI client explicitly selected a temperature.
  if (toolTurn && request.temperature === undefined) {
    body.temperature = 0;
  }
  body.max_tokens = Math.min(
    tokenLimit ?? Math.min(DEFAULT_OUTPUT_TOKENS, getProxyConfig().maxOutputTokens),
    PORTAL_MAX_OUTPUT_TOKENS,
  );
  if (toolTurn) {
    // Portal-native tools are textual and model-specific. The OpenAI tool contract
    // is carried exclusively in the controlled system message above.
    body.response_format = { type: "json_object" };
  } else if (request.response_format !== undefined) {
    body.response_format = request.response_format;
  }
  return body;
}

async function parsePortalError(response: Response): Promise<{ error: PortalError; payload?: JsonObject }> {
  let payload: Record<string, unknown> | undefined;
  try {
    payload = asRecord(await readPortalJson(response));
  } catch (error) {
    if (error instanceof PortalError && !error.message.includes("returned invalid JSON")) {
      throw error;
    }
    // Use a status-shaped message below.
  }
  const error = asRecord(payload?.error);
  const message = typeof payload?.error === "string"
    ? payload.error
    : typeof error?.message === "string"
      ? error.message
      : typeof payload?.detail === "string"
        ? payload.detail
        : `Portal request failed with HTTP ${response.status}.`;
  const retryValue = error?.retry_after ?? payload?.retry_after;
  const bodyRetryAfter = typeof retryValue === "number" && Number.isFinite(retryValue) && retryValue > 0
    ? Math.min(retryValue, 86_400)
    : undefined;
  const retryAfter = retryAfterSeconds(response) ?? bodyRetryAfter;
  return {
    error: new PortalError(message, response.status, retryAfter),
    ...(payload ? { payload: payload as JsonObject } : {}),
  };
}

function countsAgainstAccount(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function getCompletion(
  body: JsonObject,
  stickyKey?: string,
  requiredAccountId?: string,
  allowEmptyContent = false,
  onFrame?: UpstreamFrameHandler,
  signal?: AbortSignal,
): Promise<{ account: ManagedAccount; completion: UpstreamCompletion }> {
  const excluded = new Set<string>();
  let lastError: PortalError | undefined;
  let lastContext: RequestDebugContext = { upstreamRequest: body };
  const attempts = requiredAccountId
    ? 1
    : Math.max(1, (await stateStore.listAccounts()).filter((account) => account.enabled).length);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let account: ManagedAccount;
    try {
      if (requiredAccountId) {
        const stored = await stateStore.getAccount(requiredAccountId);
        if (!stored || !stored.enabled) {
          throw new HttpError(409, "The response chain's assigned account is unavailable.", "invalid_request_error", "previous_response_id");
        }
        account = await accountScheduler.acquire(stickyKey, new Set((await stateStore.listAccounts()).filter((item) => item.id !== requiredAccountId).map((item) => item.id)));
      } else {
        account = await accountScheduler.acquire(stickyKey, excluded);
      }
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      if (lastError) {
        throw new ProxyRequestError(lastError, lastContext);
      }
      throw new HttpError(503, "No enabled NeuralWatt account is currently available.", "server_error", undefined, "no_account_available");
    }

    const currentContext: RequestDebugContext = {
      accountId: account.id,
      accountLabel: account.label,
      upstreamRequest: body,
    };
    let streamedOutput = false;

    try {
      if (signal?.aborted) {
        throw new ClientDisconnectedError();
      }
      const response = await portalClient.requestChat(account, body as Record<string, unknown>, signal);
      if (!response.ok) {
        const parsed = await parsePortalError(response);
        currentContext.upstreamResponse = parsed.payload;
        throw parsed.error;
      }

      let payload: Record<string, unknown> | undefined;
      let completion: UpstreamCompletion;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (body.stream === true && contentType.includes("text/event-stream")) {
        let collected;
        try {
          collected = await collectUpstreamStream(response, async (frame) => {
            if (onFrame) {
              // The portal often sends an otherwise empty role-only frame
              // first. The route already emits the OpenAI role chunk, so that
              // frame creates no client-visible state and must not prevent
              // account failover if this upstream stream then fails.
              const emitted = await onFrame(frame);
              streamedOutput ||= emitted === true;
            }
          }, getProxyConfig().maxUpstreamBytes);
        } finally {
          portalClient.finishResponse(response);
        }
        completion = collected.completion;
        payload = asRecord(completion);
      } else {
        payload = asRecord(await readPortalJson(response));
        completion = payload as unknown as UpstreamCompletion;
      }
      currentContext.upstreamResponse = payload as JsonObject | undefined;
      if (!payload) {
        throw new PortalError("The NeuralWatt portal returned a non-object completion.", 502);
      }
      const embeddedError = asRecord(completion.error);
      if (embeddedError || typeof completion.error === "string") {
        const message = typeof completion.error === "string"
          ? completion.error
          : typeof embeddedError?.message === "string"
            ? embeddedError.message
            : "Portal returned a streaming-style error payload.";
        const embeddedStatus = typeof completion.status === "number" ? completion.status : 502;
        throw new PortalError(message, embeddedStatus);
      }
      const choices = Array.isArray(completion.choices) ? completion.choices : [];
      const choice = asRecord(choices[0]);
      const message = asRecord(choice?.message);
      const content = message?.content;
      const hasStructuredCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
      const hasRepairableEmptyContent = allowEmptyContent && (content === null || content === undefined);
      if (!choice || !message || (typeof content !== "string" && !hasStructuredCalls && !hasRepairableEmptyContent)) {
        throw new PortalError("The NeuralWatt portal returned an invalid completion shape.", 502);
      }
      accountScheduler.markSuccess(account.id);
      return { account, completion };
    } catch (error) {
      if (signal?.aborted || error instanceof ClientDisconnectedError) {
        throw new ClientDisconnectedError();
      }
      // Once a client has received a delta, retrying another account would
      // duplicate or reorder its answer. Surface the failure on the current
      // stream instead of silently starting a second completion.
      if (streamedOutput) {
        const failure = error instanceof PortalError
          ? error
          : error instanceof UpstreamStreamError
            ? new PortalError(error.message, error.status, error.retryAfterSeconds)
            : new PortalError(error instanceof Error ? error.message : "Unknown portal streaming error.", 502);
        if (countsAgainstAccount(failure.status)) {
          accountScheduler.markFailure(account.id, failure.message, failure.retryAfterSeconds);
        }
        if (error instanceof ProxyRequestError) {
          throw error;
        }
        throw new ProxyRequestError(
          failure,
          currentContext,
        );
      }
      if (error instanceof UpstreamStreamError) {
        const portalError = new PortalError(error.message, error.status, error.retryAfterSeconds);
        lastError = portalError;
        lastContext = currentContext;
        if (!countsAgainstAccount(portalError.status)) {
          throw new ProxyRequestError(portalError, currentContext);
        }
        accountScheduler.markFailure(account.id, portalError.message, portalError.retryAfterSeconds);
        excluded.add(account.id);
        if (requiredAccountId) {
          throw new ProxyRequestError(portalError, currentContext);
        }
        continue;
      }
      if (error instanceof PortalError) {
        lastError = error;
        lastContext = currentContext;
        if (!countsAgainstAccount(error.status)) {
          throw new ProxyRequestError(error, currentContext);
        }
        accountScheduler.markFailure(account.id, error.message, error.retryAfterSeconds);
        excluded.add(account.id);
        if (requiredAccountId) {
          throw new ProxyRequestError(error, currentContext);
        }
      } else {
        const message = error instanceof Error ? error.message : "Unknown portal transport error.";
        accountScheduler.markFailure(account.id, message);
        lastError = new PortalError(message, 502);
        lastContext = currentContext;
        excluded.add(account.id);
      }
    } finally {
      accountScheduler.release(account.id);
    }
  }

  throw new ProxyRequestError(
    lastError ?? new PortalError("No portal account completed the request.", 503),
    lastContext,
  );
}

function validateGeneratedCalls(calls: NormalizedToolCall[], tools: ToolDefinition[], toolChoice: unknown, parallelToolCalls: boolean): void {
  if (toolChoice === "none" && calls.length > 0) {
    throw new HttpError(502, "Portal attempted a tool call despite tool_choice='none'.", "server_error");
  }
  if (toolChoice === "required" && calls.length === 0) {
    throw new HttpError(502, "Portal did not return a required tool call.", "server_error");
  }
  if (!parallelToolCalls && calls.length > 1) {
    throw new HttpError(502, "Portal returned multiple tool calls while parallel_tool_calls=false.", "server_error");
  }
  const forcedFunction = asRecord(toolChoice)?.type === "function" ? asRecord(asRecord(toolChoice)?.function)?.name : undefined;
  if (typeof forcedFunction === "string" && (calls.length === 0 || calls.some((call) => call.function.name !== forcedFunction))) {
    throw new HttpError(502, "Portal did not return the forced tool_choice.", "server_error");
  }
  for (const call of calls) {
    if (Buffer.byteLength(call.function.arguments, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
      throw new HttpError(502, "Portal returned tool arguments that exceed the adapter limit.", "server_error");
    }
    const tool = tools.find((candidate) => candidate.function.name === call.function.name);
    const { validation } = parseAndValidateToolArguments(call.function.arguments, tool?.function.parameters);
    if (!validation.valid) {
      throw new HttpError(502, `Portal returned invalid arguments for \`${call.function.name}\`: ${validation.errors.join("; ")}`, "server_error");
    }
  }
}

function assistantFrom(completion: UpstreamCompletion, tools: ToolDefinition[]): ChatMessage {
  const raw = completion.choices?.[0]?.message;
  return normaliseAssistantToolCalls(raw, tools, completion.id ?? randomUUID());
}

function outputFinishReason(completion: UpstreamCompletion, message: ChatMessage): string {
  if (message.tool_calls?.length) {
    return "tool_calls";
  }
  const upstream = completion.choices?.[0]?.finish_reason;
  return upstream === "length" ? "length" : "stop";
}

function repairMessage(error: string, attempt: number): ChatMessage {
  return {
    role: "user",
    content: [
      `This is tool-call repair attempt ${attempt}. The preceding assistant content is the original candidate; replace it instead of explaining it.`,
      "The previous tool-call JSON could not be accepted. Return the corrected JSON object only.",
      `Validation error: ${error.slice(0, 2_000)}`,
      "Preserve the original intended action when possible. Use the required envelope, a declared function name, and arguments that satisfy its JSON Schema. Emit one concise call for one file or one command, and end immediately after the JSON object.",
    ].join("\n"),
  };
}

function rawAssistantContent(completion: UpstreamCompletion): string {
  const content = completion.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function rawAssistantCandidate(completion: UpstreamCompletion): string {
  const raw = completion.choices?.[0]?.message;
  if (Array.isArray(raw?.tool_calls) && raw.tool_calls.length > 0) {
    return JSON.stringify({ type: "tool_calls", tool_calls: raw.tool_calls });
  }
  if (typeof raw?.content === "string") {
    return raw.content;
  }
  return "";
}

function repairCandidateContent(candidate: string): string {
  if (candidate.length <= MAX_TOOL_REPAIR_CANDIDATE_CHARS) {
    return candidate;
  }
  const half = Math.floor((MAX_TOOL_REPAIR_CANDIDATE_CHARS - 96) / 2);
  return [
    candidate.slice(0, half),
    "[original tool-call candidate truncated; middle omitted for repair context]",
    candidate.slice(-half),
  ].join("\n");
}

function initialReasoning(completion: UpstreamCompletion): Pick<ChatMessage, "reasoning" | "reasoning_content"> {
  const raw = completion.choices?.[0]?.message;
  return {
    ...(typeof raw?.reasoning === "string" ? { reasoning: raw.reasoning } : {}),
    ...(typeof raw?.reasoning_content === "string" ? { reasoning_content: raw.reasoning_content } : {}),
  };
}

function withInitialReasoning(
  message: ChatMessage,
  reasoning: Pick<ChatMessage, "reasoning" | "reasoning_content">,
): ChatMessage {
  const preserved = { ...message };
  delete preserved.reasoning;
  delete preserved.reasoning_content;
  return { ...preserved, ...reasoning };
}

function candidateError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown tool-call validation error.";
}

function toolCallExpectation(toolChoice: unknown): ToolCallAdapterTrace["toolCallExpected"] {
  if (toolChoice === "required") return "required";
  if (asRecord(toolChoice)?.type === "function") return "forced";
  return "auto";
}

function evaluateToolCandidate(
  completion: UpstreamCompletion,
  tools: ToolDefinition[],
  toolChoice: unknown,
  parallelToolCalls: boolean,
): { accepted: boolean; outcome: "tool_calls" | "final" | "invalid"; message: ChatMessage; error?: string } {
  const rawContent = rawAssistantContent(completion);
  const parsed = parseControlledToolEnvelopeDetailed(
    rawContent,
    tools,
    completion.id ?? randomUUID(),
  );

  // Prefer an exact controlled envelope when both content and native fields
  // are present. Some portal responses put an unusable native tool_calls array
  // beside the valid JSON content; the adapter contract makes the content the
  // authoritative channel.
  if (parsed.envelope?.type === "tool_calls") {
    const message: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: parsed.envelope.toolCalls,
    };
    try {
      validateGeneratedCalls(message.tool_calls ?? [], tools, toolChoice, parallelToolCalls);
      return { accepted: true, outcome: "tool_calls", message };
    } catch (error) {
      return { accepted: false, outcome: "invalid", message, error: candidateError(error) };
    }
  }
  if (parsed.envelope?.type === "final") {
    const message: ChatMessage = { role: "assistant", content: parsed.envelope.content };
    return envelopeAllowedForToolChoice(parsed.envelope, toolChoice)
      ? { accepted: true, outcome: "final", message }
      : {
        accepted: false,
        outcome: "invalid",
        message,
        error: "The controlled envelope violates the requested tool_choice.",
      };
  }

  let message: ChatMessage;
  try {
    message = assistantFrom(completion, tools);
  } catch (error) {
    if (!(error instanceof InvalidStructuredToolCallsError)) {
      throw error;
    }
    return {
      accepted: false,
      outcome: "invalid",
      message: { role: "assistant", content: rawAssistantCandidate(completion) },
      error: error.message,
    };
  }

  try {
    validateGeneratedCalls(message.tool_calls ?? [], tools, toolChoice, parallelToolCalls);
  } catch (error) {
    return { accepted: false, outcome: "invalid", message, error: candidateError(error) };
  }
  if (message.tool_calls?.length) {
    return { accepted: true, outcome: "tool_calls", message };
  }
  return {
    accepted: false,
    outcome: "invalid",
    message,
    error: parsed.error ?? "The controlled envelope violates the requested tool_choice.",
  };
}

export async function executeChatRequest(
  request: JsonObject,
  options?: {
    stickyKey?: string;
    requiredAccountId?: string;
    stream?: boolean;
    onUpstreamFrame?: UpstreamFrameHandler;
    signal?: AbortSignal;
  },
): Promise<ChatExecution> {
  validateChatRequest(request);
  const model = modelFromRequest(request);
  const messages = parseMessages(request.messages);
  const tools = parseTools(request.tools);

  const toolTurn = tools.length > 0 && request.tool_choice !== "none";
  const observedToolCallIds = messages
    .filter((message) => message.role === "tool" && typeof message.tool_call_id === "string")
    .map((message) => message.tool_call_id!);
  const toolAssignedAccountId = options?.requiredAccountId
    ? undefined
    : accountScheduler.accountForToolCalls(observedToolCallIds);
  const streamUpstream = (options?.stream ?? request.stream === true) && !toolTurn;
  let upstreamRequest = upstreamBody(request, model, messages, tools, streamUpstream);
  let result = await getCompletion(
    upstreamRequest,
    options?.stickyKey,
    options?.requiredAccountId ?? toolAssignedAccountId,
    toolTurn,
    streamUpstream ? options?.onUpstreamFrame : undefined,
    options?.signal,
  );
  let message: ChatMessage;
  let toolCallAdapter: ToolCallAdapterTrace | undefined;

  if (toolTurn) {
    // Keep the caller history separate from the adapter contract. Repair turns
    // append the bad candidate and exact error, then re-apply the contract so
    // it remains the final instruction in every attempt.
    const originalUpstreamMessages = portalMessages(messages);
    const firstReasoning = initialReasoning(result.completion);
    let candidate = rawAssistantCandidate(result.completion);
    let evaluation = evaluateToolCandidate(
      result.completion,
      tools,
      request.tool_choice,
      request.parallel_tool_calls !== false,
    );
    toolCallAdapter = {
      toolCallExpected: toolCallExpectation(request.tool_choice),
      initialParseSucceeded: evaluation.outcome === "tool_calls",
      finalParseSucceeded: evaluation.outcome === "tool_calls",
      initialOutcome: evaluation.outcome,
      finalOutcome: evaluation.outcome,
      repairAttempts: 0,
      maxRepairAttempts: MAX_TOOL_REPAIR_ATTEMPTS,
      errors: [],
    };

    while (!evaluation.accepted && toolCallAdapter.repairAttempts < MAX_TOOL_REPAIR_ATTEMPTS) {
      const error = evaluation.error ?? "The model output was not a valid controlled tool-call envelope.";
      toolCallAdapter.errors.push(error);
      toolCallAdapter.repairAttempts += 1;
      const repairHistory = [
        ...originalUpstreamMessages,
        withInitialReasoning({
          role: "assistant",
          content: repairCandidateContent(candidate),
        }, firstReasoning),
        repairMessage(error, toolCallAdapter.repairAttempts),
      ];
      upstreamRequest = {
        ...upstreamRequest,
        // A repair is internal protocol recovery, not a fresh creative turn.
        // Deterministic sampling improves JSON/schema correction even when
        // the caller intentionally used a higher temperature.
        temperature: 0,
        messages: withToolCallContract(
          repairHistory,
          tools,
          request.tool_choice,
          request.parallel_tool_calls !== false,
        ) as unknown as JsonValue,
      };
      try {
        result = await getCompletion(
          upstreamRequest,
          options?.stickyKey,
          result.account.id,
          true,
          undefined,
          options?.signal,
        );
      } catch (error) {
        if (error instanceof ClientDisconnectedError || options?.signal?.aborted) {
          throw new ClientDisconnectedError();
        }
        if (error instanceof ProxyRequestError) {
          error.debugContext.toolCallAdapter = toolCallAdapter;
          throw error;
        }
        throw new ProxyRequestError(error, {
          accountId: result.account.id,
          accountLabel: result.account.label,
          upstreamRequest,
          toolCallAdapter,
        });
      }
      candidate = rawAssistantCandidate(result.completion);
      evaluation = evaluateToolCandidate(
        result.completion,
        tools,
        request.tool_choice,
        request.parallel_tool_calls !== false,
      );
    }

    toolCallAdapter.finalParseSucceeded = evaluation.outcome === "tool_calls";
    toolCallAdapter.finalOutcome = evaluation.outcome;
    if (!evaluation.accepted) {
      toolCallAdapter.errors.push(evaluation.error ?? "The final repair output was invalid.");
      throw new ProxyRequestError(
        new HttpError(502, "Portal did not return a valid tool call after bounded repair.", "server_error"),
        {
          accountId: result.account.id,
          accountLabel: result.account.label,
          upstreamRequest,
          upstreamResponse: result.completion as unknown as JsonObject,
          toolCallAdapter,
        },
      );
    }
    message = withInitialReasoning(evaluation.message, firstReasoning);
  } else {
    message = assistantFrom(result.completion, tools);
  }

  try {
    validateGeneratedCalls(message.tool_calls ?? [], tools, request.tool_choice, request.parallel_tool_calls !== false);
  } catch (error) {
    throw new ProxyRequestError(error, {
      accountId: result.account.id,
      accountLabel: result.account.label,
      upstreamRequest,
      upstreamResponse: result.completion as unknown as JsonObject,
    });
  }
  if (message.tool_calls?.length) {
    accountScheduler.bindToolCalls(result.account.id, message.tool_calls.map((call) => call.id));
  }
  return {
    account: result.account,
    completion: result.completion,
    message,
    finishReason: outputFinishReason(result.completion, message),
    model,
    tools,
    upstreamRequest,
    ...(toolCallAdapter ? { toolCallAdapter } : {}),
  };
}

export function asChatCompletion(execution: ChatExecution): JsonObject {
  const completion = execution.completion;
  const message: JsonObject = {
    role: "assistant",
    content: typeof execution.message.content === "string" ? execution.message.content : null,
  };
  if (execution.message.tool_calls?.length) {
    message.tool_calls = execution.message.tool_calls as unknown as JsonValue;
  }
  if (typeof execution.message.reasoning === "string") {
    message.reasoning = execution.message.reasoning;
  }
  if (typeof execution.message.reasoning_content === "string") {
    message.reasoning_content = execution.message.reasoning_content;
  }
  if (typeof execution.message.refusal === "string") {
    message.refusal = execution.message.refusal;
  }
  return {
    id: completion.id ?? `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: completion.created ?? Math.floor(Date.now() / 1_000),
    model: execution.model,
    choices: [{
      index: 0,
      message,
      finish_reason: execution.finishReason,
    }],
    ...(completion.usage ? { usage: completion.usage as unknown as JsonValue } : {}),
  };
}

export interface ChatStreamState {
  id: string;
  created: number;
  model: string;
  roleSent: boolean;
  sawOutput: boolean;
  finishSeen: boolean;
  usageSeen: boolean;
}

export function createChatStreamState(request: JsonObject): ChatStreamState {
  return {
    id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    created: Math.floor(Date.now() / 1_000),
    model: typeof request.model === "string" && request.model ? request.model : getProxyConfig().defaultModel,
    roleSent: false,
    sawOutput: false,
    finishSeen: false,
    usageSeen: false,
  };
}

function chatStreamBase(state: ChatStreamState): JsonObject {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
  };
}

export function startChatStream(state: ChatStreamState): JsonObject {
  state.roleSent = true;
  return {
    ...chatStreamBase(state),
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
}

/** Convert one portal SSE frame into zero or more OpenAI Chat deltas. */
export function chatChunksFromUpstreamFrame(
  frame: UpstreamCompletion,
  state: ChatStreamState,
  includeUsage = false,
): JsonObject[] {
  const chunks: JsonObject[] = [];
  const choice = frame.choices?.[0];
  const delta = choice?.delta;
  const outputDelta: JsonObject = {};
  if (!state.roleSent && typeof delta?.role === "string") {
    outputDelta.role = delta.role;
    state.roleSent = true;
  }
  if (typeof delta?.content === "string" && delta.content.length > 0) {
    outputDelta.content = delta.content;
    state.sawOutput = true;
  }
  if (typeof delta?.reasoning === "string" && delta.reasoning.length > 0) {
    outputDelta.reasoning = delta.reasoning;
    state.sawOutput = true;
  }
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    outputDelta.reasoning_content = delta.reasoning_content;
    state.sawOutput = true;
  }
  if (typeof delta?.refusal === "string" && delta.refusal.length > 0) {
    outputDelta.refusal = delta.refusal;
    state.sawOutput = true;
  }
  const finishReason = choice?.finish_reason;
  if (finishReason !== undefined && finishReason !== null) {
    state.finishSeen = true;
  }
  if (Object.keys(outputDelta).length > 0 || (finishReason !== undefined && finishReason !== null)) {
    chunks.push({
      ...chatStreamBase(state),
      choices: [{ index: choice?.index ?? 0, delta: outputDelta, finish_reason: finishReason ?? null }],
    });
  }

  if (includeUsage && frame.usage) {
    state.usageSeen = true;
    chunks.push({ ...chatStreamBase(state), choices: [], usage: frame.usage as unknown as JsonValue });
  }
  return chunks;
}

function appendFallbackChatDelta(
  execution: ChatExecution,
  state: ChatStreamState,
  chunks: JsonObject[],
): void {
  const delta: JsonObject = {};
  if (!state.roleSent) {
    delta.role = "assistant";
    state.roleSent = true;
  }
  if (!state.sawOutput) {
    if (typeof execution.message.reasoning === "string" && execution.message.reasoning) {
      delta.reasoning = execution.message.reasoning;
    }
    if (typeof execution.message.reasoning_content === "string" && execution.message.reasoning_content) {
      delta.reasoning_content = execution.message.reasoning_content;
    }
    if (typeof execution.message.refusal === "string" && execution.message.refusal) {
      delta.refusal = execution.message.refusal;
    }
    if (execution.message.tool_calls?.length) {
      delta.tool_calls = execution.message.tool_calls.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: call.function,
      })) as unknown as JsonValue;
    } else if (typeof execution.message.content === "string" && execution.message.content) {
      delta.content = execution.message.content;
    }
    if (Object.keys(delta).length > 0) state.sawOutput = true;
  }
  if (Object.keys(delta).length > 0) {
    chunks.push({ ...chatStreamBase(state), choices: [{ index: 0, delta, finish_reason: null }] });
  }
}

export function finishChatStream(
  execution: ChatExecution,
  state: ChatStreamState,
  includeUsage = false,
): JsonObject[] {
  const chunks: JsonObject[] = [];
  appendFallbackChatDelta(execution, state, chunks);
  if (!state.finishSeen) {
    state.finishSeen = true;
    chunks.push({
      ...chatStreamBase(state),
      choices: [{ index: 0, delta: {}, finish_reason: execution.finishReason }],
    });
  }
  if (includeUsage && !state.usageSeen && execution.completion.usage) {
    state.usageSeen = true;
    chunks.push({ ...chatStreamBase(state), choices: [], usage: execution.completion.usage as unknown as JsonValue });
  }
  return chunks;
}

export function asChatCompletionStream(execution: ChatExecution, includeUsage = false): JsonObject[] {
  const id = execution.completion.id ?? `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const created = execution.completion.created ?? Math.floor(Date.now() / 1_000);
  const base = { id, object: "chat.completion.chunk", created, model: execution.model };
  const chunks: JsonObject[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }];
  if (typeof execution.message.reasoning === "string" && execution.message.reasoning) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning: execution.message.reasoning }, finish_reason: null }] });
  }
  if (typeof execution.message.reasoning_content === "string" && execution.message.reasoning_content) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: execution.message.reasoning_content }, finish_reason: null }] });
  }
  if (typeof execution.message.refusal === "string" && execution.message.refusal) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { refusal: execution.message.refusal }, finish_reason: null }] });
  }
  if (execution.message.tool_calls?.length) {
    chunks.push({
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: execution.message.tool_calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: call.function,
          })),
        },
        finish_reason: null,
      }],
    });
  } else if (typeof execution.message.content === "string" && execution.message.content) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { content: execution.message.content }, finish_reason: null }] });
  }
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: execution.finishReason }] });
  if (includeUsage && execution.completion.usage) {
    chunks.push({ ...base, choices: [], usage: execution.completion.usage as unknown as JsonValue });
  }
  return chunks;
}

export function stickyKeyFrom(request: Request, body: JsonObject): string | undefined {
  const supplied = typeof body.user === "string"
    ? body.user
    : request.headers.get("x-sticky-session-id") ?? request.headers.get("x-openai-session-id");
  if (supplied) {
    return supplied.slice(0, 256);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = messages
    .map(asRecord)
    .find((message) => message?.role === "user");
  if (!firstUser) {
    return undefined;
  }
  const seed = JSON.stringify(firstUser.content ?? "").slice(0, 4_096);
  return `history_${createHash("sha256").update(seed).digest("base64url").slice(0, 32)}`;
}
