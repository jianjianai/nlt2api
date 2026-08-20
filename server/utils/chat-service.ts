import { createHash, randomUUID } from "node:crypto";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import { HttpError } from "~/server/utils/http.ts";
import { parseAndValidateToolArguments, validateSchemaDefinition } from "~/server/utils/json-schema.ts";
import { portalClient, PortalError, readPortalJsonBody, retryAfterSeconds } from "~/server/utils/portal-client.ts";
import { ProxyRequestError, type RequestDebugContext } from "~/server/utils/request-errors.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { collectUpstreamStream, UpstreamStreamError, type UpstreamFrameHandler } from "~/server/utils/upstream-stream.ts";
import {
  FINAL_REPLY_MARKER,
  InvalidStructuredToolCallsError,
  type ReasoningFields,
  stripRepairReasoning,
  tagRepairReasoning,
  buildToolRepairHistory,
  envelopeAllowedForToolChoice,
  normaliseAssistantToolCalls,
  mergeSystemMessages,
  parseControlledToolEnvelopeDetailed,
  serializeAssistantToolCallsForPortal,
  withToolCallContract,
} from "~/server/utils/tool-calls.ts";
import type {
  ChatMessage,
  DebugRawBody,
  DebugUpstreamCall,
  DebugUpstreamCallType,
  JsonObject,
  JsonValue,
  ManagedAccount,
  NormalizedToolCall,
  ToolCallAdapterTrace,
  ToolDefinition,
  UpstreamCompletion,
  UpstreamUsage,
} from "~/server/utils/types.ts";

const MAX_TOOLS = 64;
const MAX_MESSAGES = 1_000;
const MAX_TOOL_DEFINITION_BYTES = 256 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const DEFAULT_OUTPUT_TOKENS = 8_192;
// The Playground currently rejects max_tokens above 8,192 even for models
// whose context window is much larger. Larger client budgets are fulfilled by
// bounded continuation rounds below.
const PORTAL_MAX_OUTPUT_TOKENS = 8_192;
const MAX_CONTINUATION_ROUNDS = 16;
const MAX_TOOL_REPAIR_ATTEMPTS = 5;
const MAX_TOOL_REPAIR_CANDIDATE_CHARS = 131_072;
const EMPTY_REPAIR_CANDIDATE = "[The previous assistant turn produced no tool-call JSON. Reconstruct the intended call from the preceding conversation and return only a valid controlled tool-call JSON object.]";

export interface ChatExecution {
  account: ManagedAccount;
  completion: UpstreamCompletion;
  message: ChatMessage;
  finishReason: string;
  model: string;
  tools: ToolDefinition[];
  upstreamRequest: JsonObject;
  upstreamCalls: DebugUpstreamCall[];
  toolCallAdapter?: ToolCallAdapterTrace;
}

export class ClientDisconnectedError extends Error {
  constructor() {
    super("The client disconnected before the completion finished.");
    this.name = "ClientDisconnectedError";
  }
}

interface UpstreamTrace {
  calls: DebugUpstreamCall[];
  type: DebugUpstreamCallType;
  round: number;
}

function jsonDebugBody(body: string): DebugRawBody {
  return { contentType: "application/json", body };
}

function responseDebugBody(body: string, contentType: string): DebugRawBody {
  return {
    contentType: contentType.includes("text/event-stream")
      ? "text/event-stream"
      : contentType.includes("application/json")
        ? "application/json"
        : "text/plain",
    body,
  };
}

function createDebugCall(trace: UpstreamTrace, account: ManagedAccount, body: JsonObject): DebugUpstreamCall {
  return {
    sequence: trace.calls.length + 1,
    type: trace.type,
    round: trace.round,
    attempt: trace.calls.filter((call) => call.type === trace.type && call.round === trace.round).length + 1,
    accountId: account.id,
    accountLabel: account.label,
    request: jsonDebugBody(JSON.stringify(body)),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "`messages` must be a non-empty array.", "invalid_request_error", "messages");
  }
  if (value.length > MAX_MESSAGES) {
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
  // Accept any positive integer budget. The upstream portal has its own
  // per-model output cap, which is clamped below in upstreamBody instead of
  // rejecting the client request here.
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new HttpError(400, "`max_tokens` must be a positive integer.", "invalid_request_error", "max_tokens");
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

export interface ValidatedChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
}

export function validateChatRequest(request: JsonObject): ValidatedChatRequest {
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
  return { model, messages, tools };
}

function portalMessages(messages: ChatMessage[], markFinalReplies = false): ChatMessage[] {
  // The Playground currently rejects the OpenAI `developer` role. Map it to
  // system, then normalize all system instructions into one message at index 0.
  const mapped = messages.map((message) => {
    const normalized = message.role === "developer" ? { ...message, role: "system" as const } : { ...message };
    for (const field of ["reasoning", "reasoning_content"] as const) {
      if (typeof normalized[field] === "string") {
        const cleaned = stripRepairReasoning(normalized[field]);
        if (cleaned) normalized[field] = cleaned;
        else delete normalized[field];
      }
    }
    if (
      markFinalReplies
      && normalized.role === "assistant"
      && typeof normalized.content === "string"
      && normalized.content.length > 0
      && !normalized.content.startsWith(FINAL_REPLY_MARKER)
      && !normalized.tool_calls?.length
    ) {
      return { ...normalized, content: `${FINAL_REPLY_MARKER}${normalized.content}` };
    }
    return normalized;
  });
  return mergeSystemMessages(serializeAssistantToolCallsForPortal(mapped));
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
  const upstreamMessages = portalMessages(messages, toolTurn);
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
  if (!toolTurn && request.response_format !== undefined) {
    body.response_format = request.response_format;
  }
  return body;
}

async function parsePortalError(response: Response): Promise<{ error: PortalError; payload?: JsonObject; raw: string }> {
  const body = await readPortalJsonBody(response);
  const payload = body.valid ? asRecord(body.value) : undefined;
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
    raw: body.raw,
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
  trace?: UpstreamTrace,
): Promise<{ account: ManagedAccount; completion: UpstreamCompletion; receivedSse: boolean }> {
  const excluded = new Set<string>();
  let lastError: PortalError | undefined;
  let lastContext: RequestDebugContext = {
    upstreamRequest: body,
    ...(trace ? { upstreamCalls: trace.calls } : {}),
  };
  const attempts = requiredAccountId
    ? 1
    : Math.max(1, (await stateStore.listAccounts()).filter((account) => account.enabled).length);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let account: ManagedAccount;
    try {
      if (requiredAccountId) {
        const stored = await stateStore.getAccount(requiredAccountId);
        if (!stored || !stored.enabled) {
          throw new HttpError(409, "The assigned account is unavailable.", "invalid_request_error", "account");
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
      ...(trace ? { upstreamCalls: trace.calls } : {}),
    };
    let debugCall: DebugUpstreamCall | undefined = trace
      ? createDebugCall(trace, account, body)
      : undefined;
    debugCall && trace!.calls.push(debugCall);
    let streamedOutput = false;
    let receivedSse = false;

    try {
      if (signal?.aborted) {
        throw new ClientDisconnectedError();
      }
      const response = await portalClient.requestChat(
        account,
        body as Record<string, unknown>,
        signal,
        trace
          ? (retry) => {
            if (debugCall && trace) {
              if (retry.status > 0) {
                debugCall.responseStatus = retry.status;
              }
              if (retry.body) {
                debugCall.response = responseDebugBody(retry.body, retry.contentType);
              }
              if (retry.error) {
                debugCall.error = retry.error;
              }
              debugCall = createDebugCall(trace, account, body);
              trace.calls.push(debugCall);
            }
          }
          : undefined,
      );
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      debugCall && (debugCall.responseStatus = response.status);
      if (!response.ok) {
        const parsed = await parsePortalError(response);
        currentContext.upstreamResponse = parsed.payload;
        if (debugCall) {
          debugCall.response = responseDebugBody(parsed.raw, contentType);
          debugCall.error = parsed.error.message;
        }
        throw parsed.error;
      }

      let payload: Record<string, unknown> | undefined;
      let completion: UpstreamCompletion;
      if (body.stream === true && contentType.includes("text/event-stream")) {
        receivedSse = true;
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
        if (debugCall) {
          debugCall.response = responseDebugBody(collected.raw, contentType);
        }
      } else {
        const parsed = await readPortalJsonBody(response);
        if (debugCall) {
          debugCall.response = responseDebugBody(parsed.raw, contentType);
        }
        payload = parsed.valid ? asRecord(parsed.value) : undefined;
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
      return { account, completion, receivedSse };
    } catch (error) {
      if (debugCall && !debugCall.error) {
        if (error instanceof UpstreamStreamError && error.rawResponse !== undefined && !debugCall.response) {
          debugCall.response = responseDebugBody(error.rawResponse, "text/event-stream");
        }
        debugCall.error = error instanceof Error ? error.message : "Unknown portal transport error.";
      }
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

function repairMessage(error: string, attempt: number, candidate: ChatMessage, parallelToolCalls: boolean): ChatMessage {
  const hasCandidate = Boolean(
    (typeof candidate.content === "string" && candidate.content.length > 0)
    || candidate.tool_calls?.length,
  );
  const candidateToolCallId = candidate.tool_calls?.find((call) => call.id)?.id;
  const context = hasCandidate
    ? "The preceding assistant message is the failed tool-call candidate; replace it instead of explaining it."
    : "The preceding assistant turn emitted no tool-call JSON. Continue from the preceding assistant/tool exchanges and produce the missing call; do not treat this repair request as a new user task.";
  // Keep the call-count rule aligned with the caller's parallel_tool_calls
  // setting: demanding a single call when parallel calls are allowed makes the
  // model drop otherwise valid calls from the failed candidate. The rule must
  // also stay domain-neutral; this proxy serves non-coding clients too.
  const callRule = parallelToolCalls
    ? "Preserve every intended call from the failed candidate; include multiple entries only when they are independent."
    : "Return exactly one call.";
  return {
    role: "tool",
    tool_call_id: candidateToolCallId ?? `call_repair_${attempt}`,
    content: [
      `This is tool-call repair attempt ${attempt}. ${context}`,
      "The previous tool-call JSON could not be accepted. Return the corrected JSON object only.",
      `Validation error: ${error.slice(0, 2_000)}`,
      `Preserve the original intended action when possible. Use the required envelope, a declared function name, and arguments that satisfy its JSON Schema. ${callRule} End immediately after the JSON object.`,
    ].join("\n"),
  };
}

function rawAssistantContent(completion: UpstreamCompletion): string {
  const content = completion.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function rawAssistantCandidate(completion: UpstreamCompletion): string {
  const raw = completion.choices?.[0]?.message;
  // Content is the controlled, authoritative channel. Only fall back to the
  // portal's native fields when no textual candidate was produced.
  if (typeof raw?.content === "string" && raw.content.length > 0) {
    return raw.content;
  }
  if (Array.isArray(raw?.tool_calls) && raw.tool_calls.length > 0) {
    return JSON.stringify({ type: "tool_calls", tool_calls: raw.tool_calls });
  }
  return "";
}

function repairCandidateContent(candidate: string): string {
  if (!candidate) {
    return EMPTY_REPAIR_CANDIDATE;
  }
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

interface RepairCandidate {
  message: ChatMessage;
  hasCandidate: boolean;
}

function repairCandidateFrom(
  completion: UpstreamCompletion,
  tools: ToolDefinition[],
  reasoning: Pick<ChatMessage, "reasoning" | "reasoning_content">,
): RepairCandidate {
  const raw = completion.choices?.[0]?.message;
  const rawToolCalls = Array.isArray(raw?.tool_calls) && raw.tool_calls.length > 0
    ? raw.tool_calls
    : undefined;
  let content = rawAssistantCandidate(completion);
  let toolCalls: NormalizedToolCall[] | undefined;

  if (rawToolCalls) {
    try {
      toolCalls = normaliseAssistantToolCalls(raw, tools, completion.id ?? randomUUID()).tool_calls;
    } catch {
      // Invalid native calls cannot be safely attached structurally. Preserve
      // their exact form in the repair candidate so the model can correct it.
      if (typeof raw?.content === "string" && raw.content.length > 0) {
        content = [
          content,
          "[native tool_calls from the same response]",
          JSON.stringify({ tool_calls: rawToolCalls }),
        ].join("\n");
      }
    }
  }

  return {
    message: {
      role: "assistant",
      content: repairCandidateContent(content),
      ...reasoning,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    },
    hasCandidate: content.length > 0 || Boolean(toolCalls?.length),
  };
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
      content: parsed.envelope.preamble ?? null,
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

async function executeChatRequestOnce(
  request: JsonObject,
  options?: {
    stickyKey?: string;
    requiredAccountId?: string;
    stream?: boolean;
    onUpstreamFrame?: UpstreamFrameHandler;
    onRepairReasoning?: (reasoning: ReasoningFields) => void | Promise<void>;
    signal?: AbortSignal;
    upstreamCalls?: DebugUpstreamCall[];
    upstreamType?: DebugUpstreamCallType;
    upstreamRound?: number;
    validated?: ValidatedChatRequest;
  },
): Promise<ChatExecution> {
  const { model, messages, tools } = options?.validated ?? validateChatRequest(request);

  const toolTurn = tools.length > 0 && request.tool_choice !== "none";
  const observedToolCallIds = messages
    .filter((message) => message.role === "tool" && typeof message.tool_call_id === "string")
    .map((message) => message.tool_call_id!);
  const toolAssignedAccountId = options?.requiredAccountId
    ? undefined
    : accountScheduler.accountForToolCalls(observedToolCallIds);
  const streamUpstream = options?.stream ?? request.stream === true;
  let upstreamRequest = upstreamBody(request, model, messages, tools, streamUpstream);
  let result = await getCompletion(
    upstreamRequest,
    options?.stickyKey,
    options?.requiredAccountId ?? toolAssignedAccountId,
    toolTurn,
    streamUpstream ? options?.onUpstreamFrame : undefined,
    options?.signal,
    options?.upstreamCalls
      ? { calls: options.upstreamCalls, type: options.upstreamType ?? "initial", round: options.upstreamRound ?? 1 }
      : undefined,
  );
  let message: ChatMessage;
  let toolCallAdapter: ToolCallAdapterTrace | undefined;

  if (toolTurn) {
    // Keep the caller history separate from the adapter contract. The adapter
    // contract and the internal reminder are applied once to the original
    // history; repair turns then append the failed candidate and the exact
    // error after the reminder so the reminder always stays right after the
    // user instruction instead of after the error message.
    const originalUpstreamMessages = portalMessages(messages, true);
    const contractedOriginalMessages = withToolCallContract(
      originalUpstreamMessages,
      tools,
      request.tool_choice,
      request.parallel_tool_calls !== false,
    );
    const firstReasoning = initialReasoning(result.completion);
    // The portal occasionally returns a JSON completion even after accepting
    // a streaming request. Forward the original reasoning before a repair so
    // clients retain the same progressive feedback as the SSE path.
    if (
      !result.receivedSse
      && options?.onUpstreamFrame
      && (firstReasoning.reasoning || firstReasoning.reasoning_content)
    ) {
      await options.onUpstreamFrame({
        choices: [{ delta: { role: "assistant", ...firstReasoning } }],
      });
    }
    let repairCandidate = repairCandidateFrom(result.completion, tools, firstReasoning);
    let repairReasoning: ReasoningFields | undefined;
    let repairReasoningOpen = false;
    const collectRepairReasoning = async (fields: ReasoningFields): Promise<void> => {
      const tagged = tagRepairReasoning(fields, { start: !repairReasoningOpen });
      repairReasoningOpen = true;
      repairReasoning = {
        reasoning: `${repairReasoning?.reasoning ?? ""}${tagged.reasoning ?? ""}` || undefined,
        reasoning_content: `${repairReasoning?.reasoning_content ?? ""}${tagged.reasoning_content ?? ""}` || undefined,
      };
      await options?.onRepairReasoning?.(tagged);
    };
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
      const repairHistory = buildToolRepairHistory(
        contractedOriginalMessages,
        repairCandidate.message,
        repairMessage(error, toolCallAdapter.repairAttempts, repairCandidate.message, request.parallel_tool_calls !== false),
      );
      const repairStream = Boolean(options?.onRepairReasoning);
      upstreamRequest = {
        ...upstreamRequest,
        // Repair content remains internal. When a client stream is active, the
        // upstream repair request may stream only its reasoning through the
        // filtered callback below.
        stream: repairStream,
        // A repair is internal protocol recovery, not a fresh creative turn.
        // Deterministic sampling improves JSON/schema correction even when
        // the caller intentionally used a higher temperature.
        temperature: 0,
        messages: repairHistory as unknown as JsonValue,
      };
      try {
        result = await getCompletion(
          upstreamRequest,
          options?.stickyKey,
          result.account.id,
          true,
          repairStream
            ? async (frame) => {
              const fields = initialReasoning({ choices: [{ message: frame.choices?.[0]?.delta }] });
              if (fields.reasoning || fields.reasoning_content) {
                await collectRepairReasoning(fields);
                return true;
              }
              return false;
            }
            : undefined,
          options?.signal,
          options?.upstreamCalls
            ? { calls: options.upstreamCalls, type: "repair", round: toolCallAdapter.repairAttempts }
            : undefined,
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
      // A stream-requesting portal may still fall back to a JSON completion.
      // Its repair reasoning was not delivered through the frame callback, so
      // forward/tag it here just as a non-streaming repair does.
      if (!result.receivedSse) {
        const nextRepairReasoning = initialReasoning(result.completion);
        if (nextRepairReasoning.reasoning || nextRepairReasoning.reasoning_content) {
          await collectRepairReasoning(nextRepairReasoning);
        }
      }
      const nextCandidate = repairCandidateFrom(result.completion, tools, firstReasoning);
      // A reasoning-only upstream reply is not an error candidate. Retain the
      // prior malformed call so the next repair has a concrete object to fix.
      if (nextCandidate.hasCandidate) {
        repairCandidate = nextCandidate;
      }
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
    if (repairReasoning) {
      message = {
        ...message,
        ...(repairReasoning.reasoning ? { reasoning: `${message.reasoning ?? ""}${repairReasoning.reasoning}` } : {}),
        ...(repairReasoning.reasoning_content
          ? { reasoning_content: `${message.reasoning_content ?? ""}${repairReasoning.reasoning_content}` }
          : {}),
      };
    }
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
    upstreamCalls: options?.upstreamCalls ?? [],
    ...(toolCallAdapter ? { toolCallAdapter } : {}),
  };
}

function requestedOutputBudget(request: JsonObject): number | undefined {
  const value = request.max_completion_tokens ?? request.max_tokens;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function requestWithOutputBudget(request: JsonObject, budget: number): JsonObject {
  if (request.max_completion_tokens !== undefined) {
    return { ...request, max_completion_tokens: budget };
  }
  return { ...request, max_tokens: budget };
}

function continuationMessage(message: ChatMessage): ChatMessage | undefined {
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning === "string" ? message.reasoning : undefined;
  const reasoningContent = typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;
  if (!content && !reasoning && !reasoningContent) {
    return undefined;
  }
  return {
    role: "assistant",
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
}

function appendContinuationMessage(
  accumulated: ChatMessage,
  next: ChatMessage,
): ChatMessage {
  const append = (left: unknown, right: unknown): string | undefined => {
    const a = typeof left === "string" ? left : "";
    const b = typeof right === "string" ? right : "";
    return a || b ? `${a}${b}` : undefined;
  };
  return {
    role: "assistant",
    content: append(accumulated.content, next.content) ?? "",
    ...(append(accumulated.reasoning, next.reasoning) ? { reasoning: append(accumulated.reasoning, next.reasoning) } : {}),
    ...(append(accumulated.reasoning_content, next.reasoning_content)
      ? { reasoning_content: append(accumulated.reasoning_content, next.reasoning_content) }
      : {}),
  };
}

function addUsageTotals(
  total: UpstreamUsage | undefined,
  usage: UpstreamUsage | undefined,
): UpstreamUsage | undefined {
  if (!total && !usage) return undefined;
  const merged: UpstreamUsage = { ...(total ?? {}), ...(usage ?? {}) };
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const left = typeof total?.[key] === "number" ? total[key] : 0;
    const right = typeof usage?.[key] === "number" ? usage[key] : 0;
    if (left || right) merged[key] = left + right;
  }
  return merged;
}

export async function executeChatRequest(
  request: JsonObject,
  options?: {
    stickyKey?: string;
    requiredAccountId?: string;
    stream?: boolean;
    onUpstreamFrame?: UpstreamFrameHandler;
    onRepairReasoning?: (reasoning: ReasoningFields) => void | Promise<void>;
    signal?: AbortSignal;
    validated?: ValidatedChatRequest;
  },
): Promise<ChatExecution> {
  const { validated: prevalidated, ...forwardedOptions } = options ?? {};
  // Validate once per client request. Continuation rounds below only append
  // internally constructed messages and shrink the token budget, so they reuse
  // this result instead of re-running the full validation pipeline.
  const validated = prevalidated ?? validateChatRequest(request);
  const budget = requestedOutputBudget(request);
  // Tool-call turns use a controlled JSON envelope and must remain atomic.
  const toolTurn = Array.isArray(request.tools) && request.tools.length > 0 && request.tool_choice !== "none";
  const canContinue = !toolTurn && budget !== undefined && budget > PORTAL_MAX_OUTPUT_TOKENS;
  const maxRounds = canContinue ? MAX_CONTINUATION_ROUNDS : 1;
  let remaining = budget;
  let currentRequest = canContinue ? requestWithOutputBudget(request, Math.min(budget, PORTAL_MAX_OUTPUT_TOKENS)) : request;
  let currentValidated = validated;
  let execution: ChatExecution | undefined;
  let accumulatedMessage: ChatMessage | undefined;
  let accumulatedUsage: UpstreamUsage | undefined;
  let didContinue = false;
  const upstreamCalls: DebugUpstreamCall[] = [];

  for (let round = 0; round < maxRounds; round += 1) {
    const relayFrame: UpstreamFrameHandler | undefined = forwardedOptions.onUpstreamFrame
      ? async (frame) => {
        const choice = frame.choices?.[0];
        // Each upstream round is an internal segment. Hold its terminal frame
        // and usage until all continuation rounds have been combined.
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
          return false;
        }
        if (frame.usage) {
          return false;
        }
        return forwardedOptions.onUpstreamFrame!(frame);
      }
      : undefined;

    let current: ChatExecution;
    try {
      if (round > 0) {
        const continuation = buildContinuationRequest(
          request,
          validated,
          accumulatedMessage!,
          Math.min(remaining!, PORTAL_MAX_OUTPUT_TOKENS),
        );
        currentRequest = continuation.request;
        currentValidated = continuation.validated;
      }
      current = await executeChatRequestOnce(currentRequest, {
        ...forwardedOptions,
        requiredAccountId: execution?.account.id ?? forwardedOptions.requiredAccountId,
        onUpstreamFrame: relayFrame,
        onRepairReasoning: forwardedOptions.onRepairReasoning,
        upstreamCalls,
        upstreamType: round === 0 ? "initial" : "continuation",
        upstreamRound: round === 0 ? 1 : round,
        validated: currentValidated,
      });
    } catch (error) {
      if (error instanceof ProxyRequestError) {
        error.debugContext.upstreamCalls = upstreamCalls;
        throw error;
      }
      if (upstreamCalls.length > 0) {
        throw new ProxyRequestError(error, { upstreamCalls });
      }
      throw error;
    }
    execution = current;
    accumulatedMessage = accumulatedMessage
      ? appendContinuationMessage(accumulatedMessage, current.message)
      : continuationMessage(current.message);
    accumulatedUsage = addUsageTotals(accumulatedUsage, current.completion.usage);

    const consumed = typeof current.completion.usage?.completion_tokens === "number"
      ? current.completion.usage.completion_tokens
      : PORTAL_MAX_OUTPUT_TOKENS;
    if (remaining !== undefined) {
      remaining = Math.max(0, remaining - consumed);
    }
    const shouldContinue = canContinue
      && current.finishReason === "length"
      && (remaining ?? 0) > 0
      && accumulatedMessage !== undefined
      && !current.message.tool_calls?.length
      && round + 1 < maxRounds;

    if (!shouldContinue) {
      break;
    }

    didContinue = true;
    if (!accumulatedMessage) {
      break;
    }
  }

  if (!execution) {
    throw new HttpError(502, "The portal returned no completion.", "server_error");
  }
  if (didContinue && accumulatedMessage) {
    execution = {
      ...execution,
      message: accumulatedMessage,
      completion: {
        ...execution.completion,
        choices: [{
          index: 0,
          message: accumulatedMessage,
          finish_reason: execution.finishReason,
        }],
        ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
      },
    };
  }
  return execution;
}

const CONTINUATION_USER_PROMPT = "Continue the previous response from exactly where it ended. Do not repeat any text. Finish the answer if possible.";

/**
 * Build the next continuation request together with its validated form. The
 * two appended messages are constructed here and always satisfy parseMessages,
 * so the validated message list reuses the base validation instead of
 * re-checking the entire history. The history cap is still enforced exactly
 * the way parseMessages would enforce it for the rebuilt request.
 */
export function buildContinuationRequest(
  request: JsonObject,
  base: ValidatedChatRequest,
  assistant: ChatMessage,
  budget: number,
): { request: JsonObject; validated: ValidatedChatRequest } {
  const userMessage: ChatMessage = { role: "user", content: CONTINUATION_USER_PROMPT };
  const rawMessages = [
    ...(Array.isArray(request.messages) ? request.messages : []),
    assistant as unknown as JsonValue,
    userMessage as unknown as JsonValue,
  ];
  if (rawMessages.length > MAX_MESSAGES) {
    throw new HttpError(400, "`messages` exceeds the supported history limit.", "invalid_request_error", "messages");
  }
  return {
    request: requestWithOutputBudget({ ...request, messages: rawMessages as unknown as JsonValue }, budget),
    validated: { ...base, messages: [...base.messages, assistant, userMessage] },
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
  toolTurn: boolean;
  toolContentMode: "unknown" | "final" | "tool";
  toolContentBuffer: string;
  roleSent: boolean;
  contentSent: boolean;
  reasoningSent: boolean;
  reasoningContentSent: boolean;
  refusalSent: boolean;
  toolCallsSent: boolean;
  finishSeen: boolean;
  usageSeen: boolean;
}

export function createChatStreamState(request: JsonObject): ChatStreamState {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const toolTurn = tools.length > 0 && request.tool_choice !== "none";
  return {
    id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    created: Math.floor(Date.now() / 1_000),
    model: typeof request.model === "string" && request.model ? request.model : getProxyConfig().defaultModel,
    toolTurn,
    toolContentMode: toolTurn ? "unknown" : "final",
    toolContentBuffer: "",
    roleSent: false,
    contentSent: false,
    reasoningSent: false,
    reasoningContentSent: false,
    refusalSent: false,
    toolCallsSent: false,
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
    if (!state.toolTurn) {
      outputDelta.content = delta.content;
      state.contentSent = true;
    } else if (state.toolContentMode !== "tool") {
      state.toolContentBuffer += delta.content;
      if (state.toolContentMode === "unknown") {
        if (state.toolContentBuffer === FINAL_REPLY_MARKER) {
          state.toolContentMode = "final";
          state.toolContentBuffer = "";
        } else if (state.toolContentBuffer.startsWith(FINAL_REPLY_MARKER)) {
          state.toolContentMode = "final";
          state.toolContentBuffer = state.toolContentBuffer.slice(FINAL_REPLY_MARKER.length);
        } else if (!FINAL_REPLY_MARKER.startsWith(state.toolContentBuffer)) {
          state.toolContentMode = "tool";
          state.toolContentBuffer = "";
        }
      }
      if (state.toolContentMode === "final" && state.toolContentBuffer.length > 0) {
        outputDelta.content = state.toolContentBuffer;
        state.toolContentBuffer = "";
        state.contentSent = true;
      }
    }
  }
  if (typeof delta?.reasoning === "string" && delta.reasoning.length > 0) {
    outputDelta.reasoning = delta.reasoning;
    state.reasoningSent = true;
  }
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    outputDelta.reasoning_content = delta.reasoning_content;
    state.reasoningContentSent = true;
  }
  if (typeof delta?.refusal === "string" && delta.refusal.length > 0) {
    outputDelta.refusal = delta.refusal;
    state.refusalSent = true;
  }
  const finishReason = choice?.finish_reason;
  // A tool turn cannot expose the portal terminal frame: the controlled JSON
  // still needs parsing and may trigger one or more repair attempts. Emit the
  // validated OpenAI terminal state from finishChatStream instead.
  const deferFinish = state.toolTurn && finishReason !== undefined && finishReason !== null;
  if (!deferFinish && finishReason !== undefined && finishReason !== null) {
    state.finishSeen = true;
  }
  if (Object.keys(outputDelta).length > 0 || (!deferFinish && finishReason !== undefined && finishReason !== null)) {
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
  const leadingDelta: JsonObject = {};
  if (!state.roleSent) {
    leadingDelta.role = "assistant";
    state.roleSent = true;
  }
  const hasToolCalls = Boolean(execution.message.tool_calls?.length);
  if (state.toolTurn && state.toolContentMode === "unknown") {
    state.toolContentMode = "tool";
    state.toolContentBuffer = "";
  }
  if (!state.reasoningSent && typeof execution.message.reasoning === "string" && execution.message.reasoning) {
    leadingDelta.reasoning = execution.message.reasoning;
    state.reasoningSent = true;
  }
  if (!state.reasoningContentSent && typeof execution.message.reasoning_content === "string" && execution.message.reasoning_content) {
    leadingDelta.reasoning_content = execution.message.reasoning_content;
    state.reasoningContentSent = true;
  }
  if (!state.refusalSent && typeof execution.message.refusal === "string" && execution.message.refusal) {
    leadingDelta.refusal = execution.message.refusal;
    state.refusalSent = true;
  }
  if (!state.contentSent && typeof execution.message.content === "string" && execution.message.content) {
    leadingDelta.content = execution.message.content;
    state.contentSent = true;
  }
  if (Object.keys(leadingDelta).length > 0) {
    chunks.push({ ...chatStreamBase(state), choices: [{ index: 0, delta: leadingDelta, finish_reason: null }] });
  }
  if (hasToolCalls && !state.toolCallsSent) {
    const toolDelta: JsonObject = {
      tool_calls: execution.message.tool_calls!.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: call.function,
      })) as unknown as JsonValue,
    };
    state.toolCallsSent = true;
    chunks.push({ ...chatStreamBase(state), choices: [{ index: 0, delta: toolDelta, finish_reason: null }] });
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
  if (typeof execution.message.content === "string" && execution.message.content) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { content: execution.message.content }, finish_reason: null }] });
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
