import { createHash, randomUUID } from "node:crypto";
import type { UsageAttemptHandle, UsageExecutionTracker } from "~/server/utils/usage-analytics.ts";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";
import { parse as parseJsonSourceMap } from "json-source-map";
import { accountScheduler, type AccountLease } from "~/server/utils/account-scheduler.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import { HttpError } from "~/server/utils/http.ts";
import {
  minimalSchemaExample,
  parseAndValidateToolArgumentsLocated,
  validateSchemaDefinition,
  type LocatedSchemaValidationResult,
} from "~/server/utils/json-schema.ts";
import { portalClient, PortalError, readPortalJsonBody, retryAfterSeconds } from "~/server/utils/portal-client.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { egressIdentity, ProxyTransportError } from "~/server/utils/proxy.ts";
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
  isValidToolCallId,
  normaliseAssistantToolCalls,
  mergeSystemMessages,
  parseControlledToolEnvelopeDetailed,
  parseRepairJson,
  serializeAssistantToolCallsForPortal,
  withToolCallContract,
  type PreambleVerbosity,
  type ToolCallFormat,
} from "~/server/utils/tool-calls.ts";
import {
  buildXmlSkeleton,
  detectEnvelopeFormat,
  extractXmlCallNames,
} from "~/server/utils/xml-tool-calls.ts";
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

const MAX_TOOLS = 512;
const MAX_TOOL_DEFINITION_BYTES = 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const DEFAULT_OUTPUT_TOKENS = 8_192;
// The Playground currently rejects max_tokens above 8,192 even for models
// whose context window is much larger. Larger client budgets are fulfilled by
// bounded continuation rounds below, but only when the upstream was cut off
// while still thinking (finish_reason "length" with empty content). A
// truncated non-empty answer is returned as-is with finish_reason "length".
const PORTAL_MAX_OUTPUT_TOKENS = 8_192;
const MAX_CONTINUATION_ROUNDS = 16;
const MAX_TOOL_REPAIR_ATTEMPTS = 5;
const MAX_TOOL_REPAIR_CANDIDATE_CHARS = 131_072;
// From this attempt on, the correction carries a prefill skeleton: static
// rules alone stop converging once the model has failed twice.
const REPAIR_ESCALATION_ATTEMPT = 3;
const MAX_REPAIR_SKELETON_CALLS = 3;
const MAX_REPAIR_SKELETON_CHARS = 4_000;
const EMPTY_REPAIR_CANDIDATE = "[The previous assistant turn produced no tool-call envelope. Reconstruct the intended calls from the preceding conversation and return only a valid controlled tool-call envelope.]";

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
  const maxMessages = getProxyConfig().maxChatMessages;
  if (value.length > maxMessages) {
    // 413, not 400: the request is well-formed but exceeds a server payload
    // limit, matching the body-size handling in http.ts.
    throw new HttpError(413, `\`messages\` exceeds the supported history limit (limit ${maxMessages} messages; raise NEURALWATT_MAX_CHAT_MESSAGES).`, "invalid_request_error", "messages");
  }

  return value.map((raw, index) => {
    const message = asRecord(raw);
    const role = message?.role;
    if (!message || !["system", "developer", "user", "assistant", "tool"].includes(String(role))) {
      throw new HttpError(400, `messages[${index}] has an unsupported role.`, "invalid_request_error", "messages");
    }
    if (role === "tool") {
      if (!isValidToolCallId(message.tool_call_id)) {
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
    if (tool?.type !== "function" || !functionDefinition || typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
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
  // Without tools every tool_choice is a no-op selection: the turn is a
  // non-tool turn regardless, and clients such as Codex send "required" or a
  // named function even when every declared tool was dropped or absent.
  if (tools.length === 0 || value === undefined || value === "auto" || value === "none" || value === "required") {
    return;
  }
  const choice = asRecord(value);
  const functionName = asRecord(choice?.function)?.name;
  if (choice?.type !== "function" || typeof functionName !== "string" || !tools.some((tool) => tool.function.name === functionName)) {
    throw new HttpError(400, "`tool_choice` must reference one of the supplied functions.", "invalid_request_error", "tool_choice");
  }
}

export function modelFromRequest(request: JsonObject): string {
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
  /** The policy the contract was applied with; repair re-encoding reuses it. */
  toolCallPolicy: ToolCallPolicy;
  /**
   * Portal-ready messages built during validation (contract applied, system
   * messages merged, schemas serialized). Execution reuses them instead of
   * re-running the message pipeline; the only stream-dependent output of the
   * builder is the body's `stream` flag.
   */
  upstreamMessages: ChatMessage[];
}

/**
 * The effective tool-call contract policy for one request: which envelope
 * wire format the contract offers and how readily it asks for preambles.
 */
export interface ToolCallPolicy {
  format: ToolCallFormat;
  preambleVerbosity: PreambleVerbosity;
}

/** The env-configured policy, used when no admin setting overrides it. */
function envToolCallPolicy(): ToolCallPolicy {
  const config = getProxyConfig();
  return { format: config.toolCallFormat, preambleVerbosity: config.preambleVerbosity };
}

/**
 * Resolve the effective policy for one model: per-model override first, then
 * the global admin setting, then the env config.
 */
export async function resolveToolCallPolicy(model: string): Promise<ToolCallPolicy> {
  const settings = await stateStore.getSettings();
  const env = envToolCallPolicy();
  return {
    format: settings.modelToolCallFormats?.[model] ?? settings.toolCallFormat ?? env.format,
    preambleVerbosity: settings.modelPreambleVerbosities?.[model] ?? settings.preambleVerbosity ?? env.preambleVerbosity,
  };
}

export function validateChatRequest(request: JsonObject, toolCallPolicy?: ToolCallPolicy): ValidatedChatRequest {
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
  const policy = toolCallPolicy ?? envToolCallPolicy();
  const built = upstreamBody(request, model, messages, tools, false, undefined, policy);
  return { model, messages, tools, toolCallPolicy: policy, upstreamMessages: built.messages };
}

/**
 * Reject requests for models no enabled account can serve. Accounts that
 * support the model but are cooling down are left to the scheduler, which
 * reports them as temporarily unavailable.
 */
export async function assertModelSupported(model: string): Promise<void> {
  const accounts = await stateStore.listAccounts();
  const enabled = accounts.filter((account) => account.enabled);
  if (enabled.length === 0) {
    throw new HttpError(503, "No enabled NeuralWatt account is currently available.", "server_error", undefined, "no_account_available");
  }
  if (!enabled.some((account) => account.models.includes(model))) {
    throw new HttpError(404, `The model '${model}' is not supported by any enabled account.`, "invalid_request_error", "model", "model_not_supported");
  }
}

function portalMessages(messages: ChatMessage[], markFinalReplies = false, toolCallFormat: ToolCallFormat = "json"): ChatMessage[] {
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
  return mergeSystemMessages(serializeAssistantToolCallsForPortal(mapped, toolCallFormat));
}

function upstreamBody(
  request: JsonObject,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  stream: boolean,
  prebuiltMessages?: ChatMessage[],
  toolCallPolicy?: ToolCallPolicy,
  minimumOutputTokens = getProxyConfig().minimumOutputTokens,
): { body: JsonObject; messages: ChatMessage[] } {
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
  // Validation already ran the message pipeline (contract application, system
  // merge, schema serialization); only the scalar body fields, including
  // `stream`, are rebuilt per execution.
  const policy = toolCallPolicy ?? envToolCallPolicy();
  const upstreamMessages = prebuiltMessages ?? (toolTurn
    ? withToolCallContract(
      portalMessages(messages, true, policy.format),
      tools,
      toolChoice,
      parallelToolCalls,
      policy.format,
      policy.preambleVerbosity,
    )
    : portalMessages(messages, false));
  const body: JsonObject = {
    model,
    messages: upstreamMessages as unknown as JsonValue,
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
  body.max_tokens = resolvePortalOutputBudget(request, minimumOutputTokens);
  if (!toolTurn && request.response_format !== undefined) {
    body.response_format = request.response_format;
  }
  return { body, messages: upstreamMessages };
}

/** Resolve one portal round without changing the client-visible requested budget. */
export function resolvePortalOutputBudget(request: JsonObject, minimumOutputTokens: number): number {
  const requested = validateTokenLimit(request) ?? Math.min(DEFAULT_OUTPUT_TOKENS, getProxyConfig().maxOutputTokens);
  return Math.min(Math.max(requested, minimumOutputTokens), PORTAL_MAX_OUTPUT_TOKENS);
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
    error: new PortalError(message, response.status, retryAfter, payload as JsonObject | undefined),
    raw: body.raw,
    ...(payload ? { payload: payload as JsonObject } : {}),
  };
}

function countsAgainstAccount(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

const MODEL_CAPACITY_PATTERN = /(?:concurrent(?:cy)?[_ -]?(?:limit|slots?)|slots?\s+in\s+use|\d+\/\d+\s+slots?)/i;

function structuredCapacitySignal(value: unknown): boolean {
  if (typeof value === "string") return MODEL_CAPACITY_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(structuredCapacitySignal);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    MODEL_CAPACITY_PATTERN.test(key) || structuredCapacitySignal(entry));
}

export function isModelCapacityError(error: PortalError): boolean {
  return structuredCapacitySignal(error.payload) || MODEL_CAPACITY_PATTERN.test(error.message);
}

function markCapacityFailure(accountId: string, model: string, error: PortalError, admissionSequence: number): void {
  if (isModelCapacityError(error)) {
    accountScheduler.markModelCapacityFailure(
      accountId,
      model,
      error.message,
      error.retryAfterSeconds,
      admissionSequence,
    );
    return;
  }
  accountScheduler.markFailure(accountId, error.message, error.retryAfterSeconds, admissionSequence);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function getCompletion(
  body: JsonObject,
  stickyKey?: string,
  requiredAccountId?: string,
  allowEmptyContent = false,
  onFrame?: UpstreamFrameHandler,
  signal?: AbortSignal,
  trace?: UpstreamTrace,
  analytics?: UsageExecutionTracker,
): Promise<{ account: ManagedAccount; completion: UpstreamCompletion; receivedSse: boolean }> {
  const excluded = new Set<string>();
  let lastError: PortalError | undefined;
  let lastContext: RequestDebugContext = {
    upstreamRequest: body,
    ...(trace ? { upstreamCalls: trace.calls } : {}),
  };
  const model = typeof body.model === "string" && body.model ? body.model : getProxyConfig().defaultModel;
  // Required accounts are affinity preferences. The scheduler spills to
  // another eligible account when the preferred account lacks capacity.
  let rotationAttempted = false;
  let retryAccountSnapshot: ManagedAccount | undefined;
  const enabledAccountCount = (await stateStore.listAccounts()).filter((account) => account.enabled).length;
  // One extra outer attempt is reserved for a successful proxy rotation even
  // when the deployment has only one account.
  const attempts = Math.max(1, enabledAccountCount) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let lease: AccountLease;
    try {
      lease = await accountScheduler.acquire(retryAccountSnapshot
        ? { model, accountSnapshot: retryAccountSnapshot, signal }
        : {
            model,
            stickyKey,
            ...(requiredAccountId && attempt === 0 ? { preferredAccountId: requiredAccountId } : {}),
            excludedAccountIds: excluded,
            signal,
          });
      retryAccountSnapshot = undefined;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw new ClientDisconnectedError();
      }
      if (error instanceof HttpError) {
        throw error;
      }
      if (lastError) {
        throw new ProxyRequestError(lastError, lastContext);
      }
      throw new HttpError(503, "No enabled NeuralWatt account is currently available.", "server_error", undefined, "no_account_available");
    }
    const account = lease.account;

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
    let observedAttemptUsage: UpstreamUsage | undefined;
    let analyticsAttempt: UsageAttemptHandle | undefined = analytics?.startAttempt({
      type: trace?.type ?? "initial",
      model,
      accountId: account.id,
      egressHash: egressIdentity(account.proxy).id,
    });
    const finishAnalyticsAttempt = (status: number, outcome: "success" | "failure" | "aborted", usage?: UpstreamUsage): void => {
      analytics?.finishAttempt(analyticsAttempt, { status, outcome, usage });
      analyticsAttempt = undefined;
    };
    const startRetryAnalyticsAttempt = (): void => {
      analyticsAttempt = analytics?.startAttempt({
        type: "retry",
        model,
        accountId: account.id,
        egressHash: egressIdentity(account.proxy).id,
      });
    };
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
          ? async (retry) => {
            finishAnalyticsAttempt(retry.status, "failure");
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
            // The failed attempt consumed RPM but no longer needs a
            // concurrency slot while the portal backs off or refreshes auth.
            lease.release();
          }
          : async (retry) => {
            finishAnalyticsAttempt(retry.status, "failure");
            lease.release();
          },
        async () => {
          lease = await accountScheduler.acquire({
            model,
            accountSnapshot: account,
            signal,
          });
          startRetryAnalyticsAttempt();
        },
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
      observedAttemptUsage = completion?.usage;
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
        const errorPayload: JsonObject = embeddedError
          ? { error: embeddedError as JsonObject }
          : { error: String(completion.error) };
        throw new PortalError(message, embeddedStatus, undefined, errorPayload);
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
      finishAnalyticsAttempt(response.status, "success", observedAttemptUsage);
      accountScheduler.markSuccess(account.id, lease.admissionSequence);
      return { account, completion, receivedSse };
    } catch (error) {
      const attemptStatus = error instanceof PortalError || error instanceof UpstreamStreamError
        ? error.status
        : error instanceof ClientDisconnectedError || signal?.aborted || isAbortError(error)
          ? 499
          : error instanceof HttpError
            ? error.status
            : 500;
      finishAnalyticsAttempt(attemptStatus, attemptStatus === 499 ? "aborted" : "failure", observedAttemptUsage);
      if (error instanceof HttpError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new ClientDisconnectedError();
      }
      if (error instanceof ProxyTransportError) {
        if (debugCall && !debugCall.error) debugCall.error = error.message;
        if (rotationAttempted) {
          await proxyPoolService.markBoundProxyError(account, error);
          throw new ProxyRequestError(error, currentContext);
        }
        const rotated = account.proxyPoolEntryId
          ? await proxyPoolService.rotate(account.id, account.proxyPoolEntryId, error, signal)
          : account.proxy
            ? await proxyPoolService.rotateCustom(account, error, signal)
            : undefined;
        rotationAttempted = Boolean(account.proxy);
        const retryAfterRotation = rotated
          && !streamedOutput
          && (await stateStore.getSettings()).proxyPool.retryCurrentRequestAfterRotation;
        if (retryAfterRotation) {
          retryAccountSnapshot = rotated.account;
          continue;
        }
        throw new ProxyRequestError(error, currentContext);
      }
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
          markCapacityFailure(account.id, model, failure, lease.admissionSequence);
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
        markCapacityFailure(account.id, model, portalError, lease.admissionSequence);
        excluded.add(account.id);
        continue;
      }
      if (error instanceof PortalError) {
        lastError = error;
        lastContext = currentContext;
        if (!countsAgainstAccount(error.status)) {
          throw new ProxyRequestError(error, currentContext);
        }
        markCapacityFailure(account.id, model, error, lease.admissionSequence);
        excluded.add(account.id);
      } else {
        const message = error instanceof Error ? error.message : "Unknown portal transport error.";
        accountScheduler.markFailure(account.id, message, undefined, lease.admissionSequence);
        lastError = new PortalError(message, 502);
        lastContext = currentContext;
        excluded.add(account.id);
      }
    } finally {
      lease.release();
    }
  }

  throw new ProxyRequestError(
    lastError ?? new PortalError("No portal account completed the request.", 503),
    lastContext,
  );
}

export function locatedSchemaErrorText(argumentsValue: string, validation: LocatedSchemaValidationResult): string {
  let pointers: Record<string, { value?: { line: number; column: number } }> = {};
  try {
    const sourceMap = parseJsonSourceMap(argumentsValue);
    pointers = sourceMap.pointers as unknown as typeof pointers;
  } catch {
    // Fall back to plain Ajv messages when the source map cannot be built.
  }
  return validation.errors.map((error) => {
    const position = pointers[error.instancePath]?.value;
    const location = position ? ` (line ${position.line + 1}, column ${position.column + 1})` : "";
    return `- ${error.instancePath}${location}: ${error.message}`;
  }).join("\n");
}

function validateGeneratedCalls(calls: NormalizedToolCall[], tools: ToolDefinition[], toolChoice: unknown, parallelToolCalls: boolean): void {
  // No declared tools means tool_choice was accepted as a no-op during
  // validation; nothing here is satisfiable or violable.
  if (tools.length === 0) {
    return;
  }
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
    const { validation } = parseAndValidateToolArgumentsLocated(call.function.arguments, tool?.function.parameters);
    if (!validation.valid) {
      const detail = locatedSchemaErrorText(call.function.arguments, validation);
      throw new HttpError(502, `Tool \`${call.function.name}\` arguments failed schema validation:\n${detail}`, "server_error");
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

export interface RepairPromptOptions {
  error: string;
  attempt: number;
  candidate: ChatMessage;
  tools: ToolDefinition[];
  toolChoice: unknown;
  parallelToolCalls: boolean;
  /** The pinned contract format; unknown-format candidates default to it. */
  format?: ToolCallFormat;
}

/** Declared function names the failed candidate tried to call. */
function candidateCallNames(candidate: ChatMessage, tools: ToolDefinition[]): string[] {
  const declared = new Set(tools.map((tool) => tool.function.name));
  const names: string[] = [];
  for (const call of candidate.tool_calls ?? []) {
    if (declared.has(call.function.name)) {
      names.push(call.function.name);
    }
  }
  if (names.length === 0 && typeof candidate.content === "string" && candidate.content.trim()) {
    const content = candidate.content.trim();
    if (detectEnvelopeFormat(content) === "xml") {
      // The candidate is known-broken XML, so names are lifted with a
      // tolerant regex pass rather than a real parse.
      names.push(...extractXmlCallNames(content, declared));
    } else {
      const parsed = parseRepairJson(content);
      if ("value" in parsed) {
        const calls = asRecord(parsed.value)?.tool_calls;
        for (const raw of Array.isArray(calls) ? calls : []) {
          const object = asRecord(raw);
          const name = asRecord(object?.function)?.name ?? object?.name;
          if (typeof name === "string" && declared.has(name)) {
            names.push(name);
          }
        }
      }
    }
  }
  return [...new Set(names)];
}

/**
 * Format-matched skeleton example for the correction turn. Models imitate
 * concrete structure far more reliably than prose rules, so every correction
 * carries a detailed skeleton in the failed candidate's own wire format —
 * an XML candidate gets an XML skeleton, a JSON candidate gets a JSON
 * skeleton — naming the functions the candidate tried to call, with
 * schema-derived example arguments. Late attempts escalate the wording from
 * "reference" to "start from this". Corrections never suggest switching
 * formats.
 */
function repairSkeletonLines(options: RepairPromptOptions): string[] {
  const escalated = options.attempt >= REPAIR_ESCALATION_ATTEMPT;
  const forced = asRecord(options.toolChoice)?.type === "function"
    ? asRecord(asRecord(options.toolChoice)?.function)?.name
    : undefined;
  let names = candidateCallNames(options.candidate, options.tools);
  if (names.length === 0 && typeof forced === "string") {
    names = [forced];
  }
  // Match the failed candidate's wire format. An unknown format falls back
  // to the pinned contract format, so a pinned conversation never shows the
  // other format's notation; unpinned ("auto") defaults to JSON, the
  // contract's primary format.
  const detected = typeof options.candidate.content === "string"
    ? detectEnvelopeFormat(options.candidate.content)
    : "unknown";
  const candidateFormat = detected !== "unknown"
    ? detected
    : options.format === "xml" || options.format === "json"
      ? options.format
      : "json";
  if (names.length === 0) {
    // No recognizable call to name: show the generic envelope shape so the
    // model still has concrete structure to imitate.
    const generic = candidateFormat === "xml"
      ? buildXmlSkeleton([{ name: "declared_function_name", arguments: { parameter_name: "value" } }])
      : JSON.stringify({
        type: "tool_calls",
        tool_calls: [{ name: "declared_function_name", arguments: { parameter_name: "value" } }],
      }, null, 2);
    return [
      "",
      escalated
        ? "Escalated repair: re-read the declared function list in the system message, copy each function name exactly, and build the envelope around those names. The envelope shape:"
        : "The envelope shape (replace the placeholder name with a declared function name and the value with real arguments):",
      generic,
    ];
  }
  const limited = (options.parallelToolCalls ? names : names.slice(0, 1)).slice(0, MAX_REPAIR_SKELETON_CALLS);
  const skeletonCalls = limited.map((name) => {
    const tool = options.tools.find((candidateTool) => candidateTool.function.name === name);
    const example = minimalSchemaExample(tool?.function.parameters);
    return {
      name,
      arguments: example && typeof example === "object" && !Array.isArray(example) ? example as JsonObject : {} as JsonObject,
    };
  });
  const intro = escalated
    ? "Escalated repair: start from this skeleton envelope; keep its structure and function names unchanged and replace every placeholder value with the real arguments from the conversation:"
    : "Reference skeleton (keep this structure and these function names; replace the example values with the real arguments from the conversation):";
  if (candidateFormat === "xml") {
    let xmlSkeleton = buildXmlSkeleton(skeletonCalls);
    if (xmlSkeleton.length > MAX_REPAIR_SKELETON_CHARS) {
      xmlSkeleton = buildXmlSkeleton(limited.map((name) => ({ name, arguments: {} })));
    }
    return [
      "",
      intro,
      xmlSkeleton,
      "Return only the completed XML envelope.",
    ];
  }
  let skeleton = JSON.stringify({ type: "tool_calls", tool_calls: skeletonCalls }, null, 2);
  if (skeleton.length > MAX_REPAIR_SKELETON_CHARS) {
    skeleton = JSON.stringify({
      type: "tool_calls",
      tool_calls: limited.map((name) => ({ name, arguments: {} })),
    }, null, 2);
  }
  return [
    "",
    intro,
    skeleton,
    "Return only the completed envelope JSON object.",
  ];
}

// Paraphrase rotation for repair corrections: repeating the identical
// correction text after a failed attempt invites the model to repeat the same
// error (an error loop). Each attempt uses a different but semantically
// equivalent wording; none of them suggests switching wire formats — the
// parser always accepts both.
const REPAIR_PARAPHRASE_VARIANTS = 3;
const REPAIR_OPENING = [
  (attempt: number) => `Tool-call repair attempt ${attempt}.`,
  (attempt: number) => `Repair attempt ${attempt} for the rejected tool-call envelope.`,
  (attempt: number) => `Tool-call correction round ${attempt}.`,
];
const REPAIR_CONTEXT_HAS_CANDIDATE = [
  "The preceding assistant message is the failed tool-call candidate; replace it instead of explaining it.",
  "The assistant message above is the rejected candidate; rewrite it rather than commenting on it.",
  "The previous assistant turn is the failed candidate; produce its corrected replacement.",
];
const REPAIR_CONTEXT_NO_CANDIDATE = [
  "The preceding assistant turn emitted no tool-call envelope. Continue from the preceding assistant/tool exchanges and produce the missing call; do not treat this repair request as a new user task.",
  "The assistant turn above produced no tool-call envelope. Resume the preceding exchanges and emit the missing call; this correction is not a new user task.",
  "No tool-call envelope appeared in the previous assistant turn. Continue the existing exchange and output the missing call without starting over.",
];
const REPAIR_DIRECTIVE = [
  "The previous tool-call envelope was rejected. Return only the corrected envelope.",
  "The gateway rejected that tool-call envelope. Reply with the corrected envelope and nothing else.",
  "That envelope failed validation. Emit the fixed envelope as your entire reply.",
];
const REPAIR_RULES_INTRO = ["Rules:", "Checklist:", "Requirements:"];
const REPAIR_RULE_ENVELOPE = [
  "- Use the required envelope and a declared function name.",
  "- The envelope must follow the required shape and call a declared function.",
  "- Follow the required envelope structure; use only declared function names.",
];
const REPAIR_RULE_SCHEMA = [
  "- Make arguments satisfy the declared JSON Schema.",
  "- Every argument must validate against the function's declared JSON Schema.",
  "- Arguments must conform to the declared JSON Schema.",
];
const REPAIR_RULE_SINGLE = [
  "- Output exactly one envelope (with all intended calls inside) and no prose, markdown, or code fences.",
  "- Return a single envelope containing all intended calls; no prose, markdown, or code fences around it.",
  "- Exactly one envelope with every intended call inside; no surrounding prose, markdown, or code fences.",
];

export function repairMessages(options: RepairPromptOptions): ChatMessage[] {
  const { error, attempt, candidate, parallelToolCalls } = options;
  const hasCandidate = Boolean(
    (typeof candidate.content === "string" && candidate.content.length > 0)
    || candidate.tool_calls?.length,
  );
  const candidateToolCallId = candidate.tool_calls?.find((call) => call.id)?.id;
  // Paraphrase rotation: repeating the identical correction text after a
  // failed attempt invites the model to repeat the same error (an error
  // loop). Each attempt uses a different but semantically equivalent
  // wording; none of them suggests switching wire formats.
  const variant = (attempt - 1) % REPAIR_PARAPHRASE_VARIANTS;
  const context = hasCandidate
    ? REPAIR_CONTEXT_HAS_CANDIDATE[variant]!
    : REPAIR_CONTEXT_NO_CANDIDATE[variant]!;
  // Keep the call-count rule aligned with the caller's parallel_tool_calls
  // setting: demanding a single call when parallel calls are allowed makes the
  // model drop otherwise valid calls from the failed candidate. The rule must
  // also stay domain-neutral; this proxy serves non-coding clients too.
  const callRule = parallelToolCalls
    ? "Preserve every intended call from the failed candidate; the corrected envelope holds one entry per intended call."
    : "Return exactly one call.";

  // Split the rejection across two role-correct messages. The `tool` message
  // carries only the validation result (data), while the corrective directive
  // (what to do next) is a separate `user` turn. Models are trained to follow
  // user turns as instructions and to treat tool turns as returned data, so
  // burying the fix instruction inside a tool result is obeyed less reliably
  // than a dedicated user correction turn.
  const rejection: ChatMessage = {
    role: "tool",
    tool_call_id: candidateToolCallId ?? `call_repair_${attempt}`,
    content: [
      "The previous tool call failed validation.",
      "",
      "Rejection details:",
      error.slice(0, 2_000),
    ].join("\n"),
  };
  const correction: ChatMessage = {
    role: "user",
    content: [
      REPAIR_OPENING[variant]!(attempt),
      context,
      "",
      REPAIR_DIRECTIVE[variant]!,
      "",
      REPAIR_RULES_INTRO[variant]!,
      REPAIR_RULE_ENVELOPE[variant]!,
      REPAIR_RULE_SCHEMA[variant]!,
      `- ${callRule}`,
      REPAIR_RULE_SINGLE[variant]!,
      ...repairSkeletonLines(options),
    ].join("\n"),
  };

  return [rejection, correction];
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
): { accepted: boolean; outcome: "tool_calls" | "final" | "invalid"; message: ChatMessage; error?: string; repaired?: boolean } {
  const rawContent = rawAssistantContent(completion);
  const parsed = parseControlledToolEnvelopeDetailed(
    rawContent,
    tools,
    completion.id ?? randomUUID(),
  );
  const repaired = parsed.repaired ? { repaired: true } : {};

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
      return { accepted: true, outcome: "tool_calls", message, ...repaired };
    } catch (error) {
      return { accepted: false, outcome: "invalid", message, error: candidateError(error), ...repaired };
    }
  }
  if (parsed.envelope?.type === "final") {
    const message: ChatMessage = { role: "assistant", content: parsed.envelope.content };
    return envelopeAllowedForToolChoice(parsed.envelope, toolChoice)
      ? { accepted: true, outcome: "final", message, ...repaired }
      : {
        accepted: false,
        outcome: "invalid",
        message,
        error: "The controlled envelope violates the requested tool_choice.",
        ...repaired,
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
    ...repaired,
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
    validated?: ValidatedChatRequest;
    toolCallPolicy?: ToolCallPolicy;
    analytics?: UsageExecutionTracker;
  },
): Promise<ChatExecution> {
  const { model, messages, tools, toolCallPolicy, upstreamMessages: prebuiltMessages } = options?.validated ?? validateChatRequest(request, options?.toolCallPolicy);

  const toolTurn = tools.length > 0 && request.tool_choice !== "none";
  const observedToolCallIds = messages
    .filter((message) => message.role === "tool" && typeof message.tool_call_id === "string")
    .map((message) => message.tool_call_id!);
  const toolAssignedAccountId = options?.requiredAccountId
    ? undefined
    : accountScheduler.accountForToolCalls(observedToolCallIds);
  const streamUpstream = options?.stream ?? request.stream === true;
  const settings = await stateStore.getSettings();
  const minimumOutputTokens = settings.minimumOutputTokens ?? getProxyConfig().minimumOutputTokens;
  const builtUpstream = upstreamBody(request, model, messages, tools, streamUpstream, prebuiltMessages, toolCallPolicy, minimumOutputTokens);
  let upstreamRequest = builtUpstream.body;
  // A client budget above the per-round portal cap enables thinking
  // continuation: when the upstream stops with finish_reason "length" while
  // the visible content is still empty, the turn was cut off mid-thought and
  // is continued below before any tool-call evaluation or repair. While
  // continuation is possible, terminal and usage frames are held back so the
  // client only ever sees the combined terminal state.
  const thinkingBudget = requestedOutputBudget(request);
  const mayContinueThinking = thinkingBudget !== undefined && thinkingBudget > PORTAL_MAX_OUTPUT_TOKENS;
  const clientFrameHandler = streamUpstream ? options?.onUpstreamFrame : undefined;
  let result = await getCompletion(
    upstreamRequest,
    options?.stickyKey,
    options?.requiredAccountId ?? toolAssignedAccountId,
    toolTurn,
    mayContinueThinking && clientFrameHandler ? holdTerminalFrames(clientFrameHandler) : clientFrameHandler,
    options?.signal,
    options?.upstreamCalls
      ? { calls: options.upstreamCalls, type: "initial", round: 1 }
      : undefined,
    options?.analytics,
  );
  if (mayContinueThinking && thinkingBudget !== undefined && isThinkingInterrupted(result.completion)) {
    result = await continueThinking(upstreamRequest, result, thinkingBudget, {
      stickyKey: options?.stickyKey,
      allowEmptyContent: toolTurn,
      onUpstreamFrame: clientFrameHandler,
      signal: options?.signal,
      upstreamCalls: options?.upstreamCalls,
      analytics: options?.analytics,
    });
  }
  let message: ChatMessage;
  let toolCallAdapter: ToolCallAdapterTrace | undefined;

  if (toolTurn) {
    // upstreamBody already applied the adapter contract and the internal
    // reminder to the original history exactly once; reuse that list so the
    // repair history cannot drift from what was actually sent. Repair turns
    // append the failed candidate, a tool-role rejection result, and a
    // user-role correction instruction after the reminder, so the reminder
    // always stays right after the user instruction instead of after the
    // error message.
    const contractedOriginalMessages = builtUpstream.messages;
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
      initialParseRepaired: evaluation.repaired === true,
      finalParseRepaired: evaluation.repaired === true,
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
        repairMessages({
          error,
          attempt: toolCallAdapter.repairAttempts,
          candidate: repairCandidate.message,
          tools,
          toolChoice: request.tool_choice,
          parallelToolCalls: request.parallel_tool_calls !== false,
          format: toolCallPolicy.format,
        }),
        toolCallPolicy.format,
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
          options?.analytics,
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
    toolCallAdapter.finalParseRepaired = evaluation.repaired === true;
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

function completionReasoningText(completion: UpstreamCompletion, field: "reasoning" | "reasoning_content"): string {
  const value = completion.choices?.[0]?.message?.[field];
  return typeof value === "string" ? value : "";
}

function consumedCompletionTokens(completion: UpstreamCompletion): number {
  const tokens = completion.usage?.completion_tokens;
  // Without usage data assume the round spent the whole per-round cap so the
  // continuation budget shrinks conservatively instead of looping forever.
  return typeof tokens === "number" ? tokens : PORTAL_MAX_OUTPUT_TOKENS;
}

/**
 * A thinking interruption means the upstream hit the output cap while still
 * reasoning: finish_reason is "length", the visible content is still empty,
 * and there is partial reasoning to continue from. A truncated non-empty
 * answer is not continued; it is returned as-is with finish_reason "length".
 */
export function isThinkingInterrupted(completion: UpstreamCompletion): boolean {
  const choice = completion.choices?.[0];
  const message = choice?.message;
  if (choice?.finish_reason !== "length" || !message) {
    return false;
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    return false;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return false;
  }
  return completionReasoningText(completion, "reasoning").length > 0
    || completionReasoningText(completion, "reasoning_content").length > 0;
}

/**
 * Wrap a client frame handler so terminal and usage frames are held back.
 * Each upstream round is an internal segment; the client only sees the
 * combined terminal state emitted after the final round.
 */
function holdTerminalFrames(handler: UpstreamFrameHandler): UpstreamFrameHandler {
  return async (frame) => {
    const choice = frame.choices?.[0];
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      return false;
    }
    if (frame.usage) {
      return false;
    }
    return handler(frame);
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
  const mergedDetails = {
    ...(total?.prompt_tokens_details ?? {}),
    ...(usage?.prompt_tokens_details ?? {}),
    cached_tokens: (typeof total?.prompt_tokens_details?.cached_tokens === "number" ? total.prompt_tokens_details.cached_tokens : 0)
      + (typeof usage?.prompt_tokens_details?.cached_tokens === "number" ? usage.prompt_tokens_details.cached_tokens : 0),
  };
  const completionDetails = {
    ...(total?.completion_tokens_details ?? {}),
    ...(usage?.completion_tokens_details ?? {}),
    reasoning_tokens: (typeof total?.completion_tokens_details?.reasoning_tokens === "number" ? total.completion_tokens_details.reasoning_tokens : 0)
      + (typeof usage?.completion_tokens_details?.reasoning_tokens === "number" ? usage.completion_tokens_details.reasoning_tokens : 0),
  };
  merged.prompt_tokens_details = mergedDetails;
  merged.completion_tokens_details = completionDetails;
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
    toolCallPolicy?: ToolCallPolicy;
    endpoint?: "/v1/chat/completions" | "/v1/responses";
  },
): Promise<ChatExecution> {
  const { validated: prevalidated, endpoint = "/v1/chat/completions", ...forwardedOptions } = options ?? {};
  // Validate once per client request; execution reuses the supplied result
  // instead of re-running the full validation pipeline.
  const validated = prevalidated ?? validateChatRequest(request, options?.toolCallPolicy);
  const analytics = usageAnalytics.beginExecution(endpoint, validated.model);
  const upstreamCalls: DebugUpstreamCall[] = [];
  try {
    const execution = await executeChatRequestOnce(request, {
      ...forwardedOptions,
      upstreamCalls,
      validated,
      analytics,
    });
    void analytics.settle({ status: 200, outcome: "success" }).catch(() => undefined);
    return execution;
  } catch (error) {
    const original = error instanceof ProxyRequestError ? error.originalError : error;
    const status = original instanceof HttpError
      ? original.status
      : original instanceof PortalError || original instanceof UpstreamStreamError
        ? original.status
        : original instanceof ClientDisconnectedError
          ? 499
          : 500;
    void analytics.settle({ status, outcome: status === 499 ? "aborted" : "failure" }).catch(() => undefined);
    if (error instanceof ProxyRequestError) {
      error.debugContext.upstreamCalls = upstreamCalls;
      throw error;
    }
    if (upstreamCalls.length > 0) {
      throw new ProxyRequestError(error, { upstreamCalls });
    }
    throw error;
  }
}

interface ThinkingContinuationOptions {
  stickyKey?: string;
  allowEmptyContent: boolean;
  onUpstreamFrame?: UpstreamFrameHandler;
  signal?: AbortSignal;
  upstreamCalls?: DebugUpstreamCall[];
  analytics?: UsageExecutionTracker;
}

/**
 * Continue a thinking-interrupted completion with the remaining output
 * budget. Each round appends the accumulated reasoning as a trailing
 * assistant turn (prefill, no extra user prompt) to the already-built
 * upstream messages (for tool turns these are the contracted messages, so
 * the tool contract stays intact), pinned to the account that produced the
 * partial thinking. Continuation reasoning is appended verbatim, without
 * the repair marker used for tool-call repair rounds.
 */
async function continueThinking(
  body: JsonObject,
  first: { account: ManagedAccount; completion: UpstreamCompletion; receivedSse: boolean },
  budget: number,
  options: ThinkingContinuationOptions,
): Promise<{ account: ManagedAccount; completion: UpstreamCompletion; receivedSse: boolean }> {
  let { account, completion, receivedSse } = first;
  let reasoning = completionReasoningText(completion, "reasoning");
  let reasoningContent = completionReasoningText(completion, "reasoning_content");
  let usage = completion.usage;
  let remaining = budget - consumedCompletionTokens(completion);
  let round = 1;
  // A JSON-fallback round never streamed its reasoning; forward it now so
  // every round's thinking reaches the client exactly once.
  const forwardReasoning = async (interrupted: UpstreamCompletion): Promise<void> => {
    if (!options.onUpstreamFrame) return;
    const fields = initialReasoning(interrupted);
    if (fields.reasoning || fields.reasoning_content) {
      await options.onUpstreamFrame({ choices: [{ delta: { role: "assistant", ...fields } }] });
    }
  };
  if (!receivedSse) {
    await forwardReasoning(completion);
  }

  while (isThinkingInterrupted(completion) && remaining > 0 && round < MAX_CONTINUATION_ROUNDS) {
    const assistant: ChatMessage = {
      role: "assistant",
      content: "",
      ...(reasoning ? { reasoning } : {}),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    };
    const continuationBody: JsonObject = {
      ...body,
      max_tokens: Math.min(remaining, PORTAL_MAX_OUTPUT_TOKENS),
      // Prefill-style continuation: the request ends with the assistant
      // message carrying the accumulated thinking. Probes showed a trailing
      // "Continue" user prompt makes reasoning models burn tokens on
      // instruction meta-reasoning and suppresses the answer body, while
      // the bare prefill just continues the thought.
      messages: [
        ...(Array.isArray(body.messages) ? body.messages : []),
        assistant as unknown as JsonValue,
      ],
    };
    const next = await getCompletion(
      continuationBody,
      options.stickyKey,
      account.id,
      options.allowEmptyContent,
      options.onUpstreamFrame ? holdTerminalFrames(options.onUpstreamFrame) : undefined,
      options.signal,
      options.upstreamCalls
        ? { calls: options.upstreamCalls, type: "continuation", round }
        : undefined,
      options.analytics,
    );
    round += 1;
    account = next.account;
    completion = next.completion;
    if (!next.receivedSse) {
      await forwardReasoning(next.completion);
    }
    receivedSse = receivedSse && next.receivedSse;
    reasoning += completionReasoningText(completion, "reasoning");
    reasoningContent += completionReasoningText(completion, "reasoning_content");
    usage = addUsageTotals(usage, completion.usage);
    remaining -= consumedCompletionTokens(completion);
  }

  const lastChoice = completion.choices?.[0];
  const merged: UpstreamCompletion = {
    ...completion,
    choices: [{
      ...lastChoice,
      index: lastChoice?.index ?? 0,
      message: {
        role: "assistant",
        content: null,
        ...(lastChoice?.message ?? {}),
        ...(reasoning ? { reasoning } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      },
      finish_reason: lastChoice?.finish_reason ?? null,
    }],
    ...(usage ? { usage } : {}),
  };
  return {
    account,
    completion: merged,
    // When a client stream is active every round's reasoning has been
    // forwarded already, so downstream JSON-fallback forwarding must not
    // repeat the accumulated reasoning.
    receivedSse: receivedSse || Boolean(options.onUpstreamFrame),
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
        // The parse side trims before checking the marker; mirror that here so
        // a final reply with leading whitespace is not misclassified as tool
        // JSON and held back from the client until the stream ends.
        const candidate = state.toolContentBuffer.trimStart();
        if (candidate === FINAL_REPLY_MARKER) {
          state.toolContentMode = "final";
          state.toolContentBuffer = "";
        } else if (candidate.startsWith(FINAL_REPLY_MARKER)) {
          state.toolContentMode = "final";
          state.toolContentBuffer = candidate.slice(FINAL_REPLY_MARKER.length);
        } else if (!FINAL_REPLY_MARKER.startsWith(candidate)) {
          // Diverged from the marker: this is tool-call JSON (or invalid prose
          // the repair loop will correct). Either way it is protocol data, so
          // suppress it from the client stream. The assembled completion keeps
          // the full content for evaluation and repair.
          state.toolContentMode = "tool";
          state.toolContentBuffer = "";
        }
        // A whitespace-only or marker-prefix buffer keeps waiting for deltas.
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
