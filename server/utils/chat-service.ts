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
import { deepInfraClient } from "~/server/utils/deepinfra-client.ts";
import { finishUpstreamResponse, readUpstreamJsonBody, retryAfterSeconds, UpstreamError } from "~/server/utils/upstream-http.ts";
import { modelIdMatches, publicModelId, upstreamModelId } from "~/server/utils/model-id.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { egressIdentity, ProxyTransportError } from "~/server/utils/proxy.ts";
import { ProxyRequestError, type RequestDebugContext } from "~/server/utils/request-errors.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { collectUpstreamStream, UpstreamStreamError, type UpstreamFrameHandler } from "~/server/utils/upstream-stream.ts";
import {
  FINAL_REPLY_MARKER,
  InvalidStructuredToolCallsError,
  type ReasoningFields,
  envelopeAllowedForToolChoice,
  isValidToolCallId,
  normaliseAssistantToolCalls,
  parseControlledToolEnvelopeDetailed,
  parseRepairJson,
  tagRepairReasoning,
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
    throw new HttpError(413, `\`messages\` exceeds the supported history limit (limit ${maxMessages} messages; raise DEEPINFRA_GATEWAY_MAX_CHAT_MESSAGES).`, "invalid_request_error", "messages");
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
    const normalized = message as ChatMessage;
    if (role === "assistant" && Array.isArray(normalized.tool_calls)) {
      // Validate history tool-call structure before any upstream work.
      normaliseAssistantToolCalls(normalized, [], "history");
    }
    return normalized;
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
    return publicModelId(getProxyConfig().defaultModel);
  }
  if (typeof model !== "string" || model.length > 200) {
    throw new HttpError(400, "`model` must be a string.", "invalid_request_error", "model");
  }
  return publicModelId(model);
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
  validateTokenLimit(request);
  const tools = parseTools(request.tools);
  const messages = parseMessages(request.messages);
  validateToolChoice(request.tool_choice, tools);
  if (request.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== "boolean") {
    throw new HttpError(400, "`parallel_tool_calls` must be a boolean.", "invalid_request_error", "parallel_tool_calls");
  }
  if (request.n !== undefined && request.n !== 1) {
    throw new HttpError(400, "Only n=1 is supported by the DeepInfra adapter.", "invalid_request_error", "n");
  }
  return { model, messages, tools };
}

/**
 * Reject requests for models no enabled account can serve. Accounts that
 * support the model but are cooling down are left to the scheduler, which
 * reports them as temporarily unavailable.
 */
export async function assertModelSupported(model: string, groupId?: string): Promise<void> {
  const accounts = await stateStore.listAccounts();
  const enabled = accounts
    .filter((account) => account.enabled)
    .filter((account) => !groupId || account.groupIds.includes(groupId));
  if (enabled.length === 0) {
    throw new HttpError(503, "No enabled DeepInfra account is currently available.", "server_error", undefined, "no_account_available");
  }
  if (!enabled.some((account) => account.models.some((candidate) => modelIdMatches(candidate, model)))) {
    throw new HttpError(404, `The model '${model}' is not supported by any enabled account.`, "invalid_request_error", "model", "model_not_supported");
  }
}

/**
 * Sampling fields accepted by DeepInfra's OpenAI-compatible endpoint.
 * `min_p` and `logit_bias` are deliberately absent: speculative decoding
 * rejects them upstream with HTTP 422.
 */
const DEEPINFRA_EXTRA_FIELDS = [
  "top_k",
  "presence_penalty",
  "frequency_penalty",
  "repetition_penalty",
  "n",
  "logprobs",
  "echo",
  "prompt_cache_key", "prompt_cache_options",
];

function promptCacheKey(request: JsonObject, messages: ChatMessage[], tools: ToolDefinition[]): string | undefined {
  if (typeof request.prompt_cache_key === "string" && request.prompt_cache_key.trim()) {
    return request.prompt_cache_key.trim().slice(0, 256);
  }
  const stablePrefix = messages.filter((message) => message.role === "system" || message.role === "developer");
  if (stablePrefix.length === 0) return undefined;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ messages: stablePrefix, tools }), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `deepinfra:${fingerprint}`;
}

function deepInfraBody(
  request: JsonObject,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  stream: boolean,
): JsonObject {
  const accepted = [
    "temperature", "top_p", "stop", "seed", "reasoning_effort", "response_format",
    "parallel_tool_calls", "tool_choice", "user", "metadata",
    ...DEEPINFRA_EXTRA_FIELDS,
  ];
  const body: JsonObject = {
    model: publicModelId(model),
    messages: messages.map((message) => ({ ...message })) as unknown as JsonValue,
    stream,
    ...(promptCacheKey(request, messages, tools) ? { prompt_cache_key: promptCacheKey(request, messages, tools) } : {}),
  };
  for (const field of accepted) {
    if (request[field] !== undefined) body[field] = request[field];
  }
  if (tools.length > 0) body.tools = tools as unknown as JsonValue;
  const budget = validateTokenLimit(request);
  if (budget !== undefined) body.max_tokens = budget;
  // `stream_options` is only legal alongside `stream: true`; DeepInfra returns 422 otherwise.
  if (stream) {
    body.stream_options = { include_usage: true, continuous_usage_stats: true };
  }
  return body;
}

async function parseUpstreamError(response: Response): Promise<{ error: UpstreamError; payload?: JsonObject; raw: string }> {
  const body = await readUpstreamJsonBody(response);
  const payload = body.valid ? asRecord(body.value) : undefined;
  const error = asRecord(payload?.error);
  const message = typeof payload?.error === "string"
    ? payload.error
    : typeof error?.message === "string"
      ? error.message
      : typeof payload?.detail === "string"
        ? payload.detail
        : `DeepInfra request failed with HTTP ${response.status}.`;
  const retryValue = error?.retry_after ?? payload?.retry_after;
  const bodyRetryAfter = typeof retryValue === "number" && Number.isFinite(retryValue) && retryValue > 0
    ? Math.min(retryValue, 86_400)
    : undefined;
  const retryAfter = retryAfterSeconds(response) ?? bodyRetryAfter;
  return {
    error: new UpstreamError(message, response.status, retryAfter, payload as JsonObject | undefined),
    raw: body.raw,
    ...(payload ? { payload: payload as JsonObject } : {}),
  };
}

function countsAgainstAccount(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

const MODEL_CAPACITY_PATTERN = /(?:concurrent(?:cy)?[_ -]?(?:limit|slots?)|slots?\s+in\s+use|model\s+busy|busy,?\s+retry\s+later|\d+\/\d+\s+slots?)/i;;

function structuredCapacitySignal(value: unknown): boolean {
  if (typeof value === "string") return MODEL_CAPACITY_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(structuredCapacitySignal);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    MODEL_CAPACITY_PATTERN.test(key) || structuredCapacitySignal(entry));
}

export function isModelCapacityError(error: UpstreamError): boolean {
  return structuredCapacitySignal(error.payload) || MODEL_CAPACITY_PATTERN.test(error.message);
}

function markCapacityFailure(accountId: string, model: string, error: UpstreamError, admissionSequence: number): void {
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

/**
 * Whether the upstream reports authoritative billing for its own request.
 * DeepInfra's free line returns only an `estimated_cost` derived from the public
 * price list, so treating it as authoritative would book estimates as real spend.
 */
function billingAuthoritative(): boolean {
  // The anonymous web route reports estimates, not an authoritative billed amount.
  return false;
}

async function getCompletion(
  body: JsonObject,
  stickyKey?: string,
  requiredAccountId?: string,
  groupId?: string,
  allowEmptyContent = false,
  onFrame?: UpstreamFrameHandler,
  signal?: AbortSignal,
  trace?: UpstreamTrace,
  analytics?: UsageExecutionTracker,
): Promise<{ account: ManagedAccount; completion: UpstreamCompletion; receivedSse: boolean }> {
  const excluded = new Set<string>();
  let lastError: UpstreamError | undefined;
  let lastContext: RequestDebugContext = {
    upstreamRequest: body,
    ...(trace ? { upstreamCalls: trace.calls } : {}),
  };
  const model = typeof body.model === "string" && body.model ? body.model : getProxyConfig().defaultModel;
  // Required accounts are affinity preferences. The scheduler spills to
  // another eligible account when the preferred account lacks capacity.
  let rotationAttempted = false;
  let retryAccountSnapshot: ManagedAccount | undefined;
  const enabledAccountCount = (await stateStore.listAccounts())
    .filter((account) => account.enabled)
    .filter((account) => !groupId || account.groupIds.includes(groupId)).length;
  // One extra outer attempt is reserved for a successful proxy rotation even
  // when the deployment has only one account.
  const attempts = Math.max(1, enabledAccountCount) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let lease: AccountLease;
    try {
      lease = await accountScheduler.acquire(retryAccountSnapshot
        ? { model, groupId, accountSnapshot: retryAccountSnapshot, signal }
        : {
            model,
            groupId,
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
      throw new HttpError(503, "No enabled DeepInfra account is currently available.", "server_error", undefined, "no_account_available");
    }
    const account = lease.account;
    const resolvedModel = upstreamModelId(account, model);
    if (!resolvedModel) {
      lease.release();
      excluded.add(account.id);
      continue;
    }
    const upstreamBodyForAccount: JsonObject = { ...body, model: resolvedModel };
    const currentContext: RequestDebugContext = {
      accountId: account.id,
      accountLabel: account.label,
      upstreamRequest: upstreamBodyForAccount,
      ...(trace ? { upstreamCalls: trace.calls } : {}),
    };
    let debugCall: DebugUpstreamCall | undefined = trace
      ? createDebugCall(trace, account, upstreamBodyForAccount)
      : undefined;
    debugCall && trace!.calls.push(debugCall);
    let streamedOutput = false;
    let observedAttemptUsage: UpstreamUsage | undefined;
    let analyticsAttempt: UsageAttemptHandle | undefined = analytics?.startAttempt({
      type: trace?.type ?? "initial",
      model,
      accountId: account.id,
      egressHash: egressIdentity(account.proxy).id,
      billingAuthoritative: billingAuthoritative(),
    });
    const finishAnalyticsAttempt = (
      status: number,
      outcome: "success" | "failure" | "aborted",
      usage?: UpstreamUsage,
      completion?: UpstreamCompletion,
    ): void => {
      analytics?.finishAttempt(analyticsAttempt, {
        status,
        outcome,
        usage,
        billing: completion ? {
          energy: completion.energy,
          cost: completion.cost,
          serviceTier: completion.service_tier,
        } : undefined,
      });
      analyticsAttempt = undefined;
    };
    const startRetryAnalyticsAttempt = (): void => {
      analyticsAttempt = analytics?.startAttempt({
        type: "retry",
        model,
        accountId: account.id,
        egressHash: egressIdentity(account.proxy).id,
        billingAuthoritative: billingAuthoritative(),
      });
    };
    let receivedSse = false;

    try {
      if (signal?.aborted) {
        throw new ClientDisconnectedError();
      }
      const response = await deepInfraClient.chat(
        upstreamBodyForAccount,
        signal,
        account.proxy,
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
              debugCall = createDebugCall(trace, account, upstreamBodyForAccount);
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
            groupId,
            accountSnapshot: account,
            signal,
          });
          startRetryAnalyticsAttempt();
        },
      );
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      debugCall && (debugCall.responseStatus = response.status);
      if (!response.ok) {
        const parsed = await parseUpstreamError(response);
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
          finishUpstreamResponse(response);
        }
        completion = collected.completion;
        payload = asRecord(completion);
        if (debugCall) {
          debugCall.response = responseDebugBody(collected.raw, contentType);
        }
      } else {
        const parsed = await readUpstreamJsonBody(response);
        if (debugCall) {
          debugCall.response = responseDebugBody(parsed.raw, contentType);
        }
        payload = parsed.valid ? asRecord(parsed.value) : undefined;
        completion = payload as unknown as UpstreamCompletion;
      }
      currentContext.upstreamResponse = payload as JsonObject | undefined;
      observedAttemptUsage = completion?.usage;
      if (!payload) {
        throw new UpstreamError("DeepInfra returned a non-object completion.", 502);
      }
      const embeddedError = asRecord(completion.error);
      if (embeddedError || typeof completion.error === "string") {
        const message = typeof completion.error === "string"
          ? completion.error
          : typeof embeddedError?.message === "string"
            ? embeddedError.message
            : "DeepInfra returned a streaming-style error payload.";
        const embeddedStatus = typeof completion.status === "number" ? completion.status : 502;
        const errorPayload: JsonObject = embeddedError
          ? { error: embeddedError as JsonObject }
          : { error: String(completion.error) };
        throw new UpstreamError(message, embeddedStatus, undefined, errorPayload);
      }
      const choices = Array.isArray(completion.choices) ? completion.choices : [];
      const choice = asRecord(choices[0]);
      const message = asRecord(choice?.message);
      const content = message?.content;
      const hasStructuredCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
      const hasRepairableEmptyContent = allowEmptyContent && (content === null || content === undefined);
      if (!choice || !message || (typeof content !== "string" && !hasStructuredCalls && !hasRepairableEmptyContent)) {
        throw new UpstreamError("DeepInfra returned an invalid completion shape.", 502);
      }
      finishAnalyticsAttempt(response.status, "success", observedAttemptUsage, completion);
      accountScheduler.markSuccess(account.id, lease.admissionSequence);
      return { account, completion, receivedSse };
    } catch (error) {
      const attemptStatus = error instanceof UpstreamError || error instanceof UpstreamStreamError
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
        // A channel account owns one stable egress. Cool it down and let the
        // scheduler select another account; never mutate its proxy identity.
        await proxyPoolService.markBoundProxyError(account, error);
        accountScheduler.markFailure(account.id, error.message, undefined, lease.admissionSequence);
        lastError = new UpstreamError(error.message, 502);
        lastContext = currentContext;
        excluded.add(account.id);
        continue;
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
        const failure = error instanceof UpstreamError
          ? error
          : error instanceof UpstreamStreamError
            ? new UpstreamError(error.message, error.status, error.retryAfterSeconds)
            : new UpstreamError(error instanceof Error ? error.message : "Unknown portal streaming error.", 502);
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
        const portalError = new UpstreamError(error.message, error.status, error.retryAfterSeconds);
        lastError = portalError;
        lastContext = currentContext;
        if (!countsAgainstAccount(portalError.status)) {
          throw new ProxyRequestError(portalError, currentContext);
        }
        markCapacityFailure(account.id, model, portalError, lease.admissionSequence);
        excluded.add(account.id);
        continue;
      }
      if (error instanceof UpstreamError) {
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
        lastError = new UpstreamError(message, 502);
        lastContext = currentContext;
        excluded.add(account.id);
      }
    } finally {
      lease.release();
    }
  }

  throw new ProxyRequestError(
    lastError ?? new UpstreamError("No portal account completed the request.", 503),
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

function nativeRepairMessages(
  originalHistory: ChatMessage[],
  candidate: ChatMessage,
  error: string,
  attempt: number,
  tools: ToolDefinition[],
  toolChoice: unknown,
  parallelToolCalls: boolean,
): ChatMessage[] {
  const calls = candidate.tool_calls ?? [];
  const declared = new Set(tools.map((tool) => tool.function.name));
  const callNames = calls.map((call) => call.function.name).filter((name) => declared.has(name));
  const forcedName = asRecord(toolChoice)?.type === "function"
    ? asRecord(asRecord(toolChoice)?.function)?.name
    : undefined;
  const names = [...new Set([
    ...callNames,
    ...(typeof forcedName === "string" ? [forcedName] : []),
  ])];
  const limited = (parallelToolCalls ? names : names.slice(0, 1)).slice(0, MAX_REPAIR_SKELETON_CALLS);
  const examples = limited.map((name) => {
    const definition = tools.find((tool) => tool.function.name === name);
    return {
      name,
      arguments: minimalSchemaExample(definition?.function.parameters) ?? {},
    };
  });
  const assistant: ChatMessage = {
    role: "assistant",
    content: typeof candidate.content === "string" ? candidate.content : null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(candidate.reasoning ? { reasoning: candidate.reasoning } : {}),
    ...(candidate.reasoning_content ? { reasoning_content: candidate.reasoning_content } : {}),
  };
  const rejections: ChatMessage[] = calls.length > 0
    ? calls.map((call) => ({
      role: "tool" as const,
      tool_call_id: call.id,
      content: `The tool call was rejected by local validation.\n\n${error.slice(0, 2_000)}`,
    }))
    : [];
  const correction: ChatMessage = {
    role: "user",
    content: [
      `Native tool-call repair attempt ${attempt}.`,
      "Repeat the intended call using the API's native tool_calls channel.",
      "Every argument must match the supplied function JSON Schema exactly; preserve JSON types such as object, array, boolean, integer, and number.",
      parallelToolCalls ? "Preserve every intended call." : "Return at most one call.",
      "Do not return a JSON/XML envelope, markdown, or an explanation.",
      ...(examples.length > 0 ? ["Schema-derived argument examples:", JSON.stringify(examples, null, 2)] : []),
      "Validation error:",
      error.slice(0, 2_000),
    ].join("\n"),
  };
  return [...originalHistory, assistant, ...rejections, correction];
}

function evaluateNativeApiToolCandidate(
  completion: UpstreamCompletion,
  tools: ToolDefinition[],
  toolChoice: unknown,
  parallelToolCalls: boolean,
): { accepted: boolean; outcome: "tool_calls" | "final" | "invalid"; message: ChatMessage; error?: string } {
  let message: ChatMessage;
  try {
    message = assistantFrom(completion, tools);
  } catch (error) {
    if (!(error instanceof InvalidStructuredToolCallsError)) throw error;
    const candidate = repairCandidateFrom(completion, tools, initialReasoning(completion));
    return { accepted: false, outcome: "invalid", message: candidate.message, error: error.message };
  }
  try {
    validateGeneratedCalls(message.tool_calls ?? [], tools, toolChoice, parallelToolCalls);
  } catch (error) {
    return { accepted: false, outcome: "invalid", message, error: candidateError(error) };
  }
  return {
    accepted: true,
    outcome: message.tool_calls?.length ? "tool_calls" : "final",
    message,
  };
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
    groupId?: string;
    stream?: boolean;
    onUpstreamFrame?: UpstreamFrameHandler;
    onRepairReasoning?: (reasoning: ReasoningFields) => void | Promise<void>;
    signal?: AbortSignal;
    upstreamCalls?: DebugUpstreamCall[];
    validated?: ValidatedChatRequest;
    analytics?: UsageExecutionTracker;
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
  let upstreamRequest = deepInfraBody(request, model, messages, tools, streamUpstream);
  const clientFrameHandler = streamUpstream ? options?.onUpstreamFrame : undefined;
  let result = await getCompletion(
    upstreamRequest,
    options?.stickyKey,
    options?.requiredAccountId ?? toolAssignedAccountId,
    options?.groupId,
    toolTurn,
    clientFrameHandler,
    options?.signal,
    options?.upstreamCalls
      ? { calls: options.upstreamCalls, type: "initial", round: 1 }
      : undefined,
    options?.analytics,
  );
  let message: ChatMessage;
  let toolCallAdapter: ToolCallAdapterTrace | undefined;

  if (toolTurn) {
    const firstReasoning = initialReasoning(result.completion);
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
    let evaluation = evaluateNativeApiToolCandidate(
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
      const error = evaluation.error ?? "The native tool call failed local validation.";
      toolCallAdapter.errors.push(error);
      toolCallAdapter.repairAttempts += 1;
      const repairStream = Boolean(options?.onRepairReasoning);
      const repairRequest: JsonObject = {
        ...upstreamRequest,
        stream: repairStream,
        ...(repairStream ? { stream_options: { include_usage: true } } : {}),
        temperature: 0,
        messages: nativeRepairMessages(
          messages,
          evaluation.message,
          error,
          toolCallAdapter.repairAttempts,
          tools,
          request.tool_choice,
          request.parallel_tool_calls !== false,
        ) as unknown as JsonValue,
      };
      result = await getCompletion(
        repairRequest,
        options?.stickyKey,
        result.account.id,
        options?.groupId,
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
      if (!result.receivedSse) {
        const fields = initialReasoning(result.completion);
        if (fields.reasoning || fields.reasoning_content) await collectRepairReasoning(fields);
      }
      evaluation = evaluateNativeApiToolCandidate(
        result.completion,
        tools,
        request.tool_choice,
        request.parallel_tool_calls !== false,
      );
    }
    toolCallAdapter.finalParseSucceeded = evaluation.outcome === "tool_calls";
    toolCallAdapter.finalOutcome = evaluation.outcome;
    if (!evaluation.accepted) {
      toolCallAdapter.errors.push(evaluation.error ?? "The final native tool-call repair output was invalid.");
      throw new ProxyRequestError(
        new HttpError(502, "DeepInfra did not return a valid tool call after bounded repair.", "server_error"),
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

export async function executeChatRequest(
  request: JsonObject,
  options?: {
    stickyKey?: string;
    requiredAccountId?: string;
    groupId?: string;
    stream?: boolean;
    onUpstreamFrame?: UpstreamFrameHandler;
    onRepairReasoning?: (reasoning: ReasoningFields) => void | Promise<void>;
    signal?: AbortSignal;
    validated?: ValidatedChatRequest;
    endpoint?: "/v1/chat/completions" | "/v1/responses";
  },
): Promise<ChatExecution> {
  const { validated: prevalidated, endpoint = "/v1/chat/completions", ...forwardedOptions } = options ?? {};
  // Validate once per client request; execution reuses the supplied result
  // instead of re-running the full validation pipeline.
  const validated = prevalidated ?? validateChatRequest(request);
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
      : original instanceof UpstreamError || original instanceof UpstreamStreamError
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
    model: publicModelId(execution.model),
    choices: [{
      index: 0,
      message,
      finish_reason: execution.finishReason,
    }],
    ...(completion.usage ? { usage: completion.usage as unknown as JsonValue } : {}),
    ...(completion.energy ? { energy: completion.energy as unknown as JsonValue } : {}),
    ...(completion.cost ? { cost: completion.cost as unknown as JsonValue } : {}),
    ...(completion.service_tier ? { service_tier: completion.service_tier } : {}),
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
    model: publicModelId(typeof request.model === "string" && request.model ? request.model : getProxyConfig().defaultModel),
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
  if (execution.completion.energy || execution.completion.cost || execution.completion.service_tier) {
    chunks.push({
      ...chatStreamBase(state),
      choices: [],
      ...(execution.completion.energy ? { energy: execution.completion.energy as unknown as JsonValue } : {}),
      ...(execution.completion.cost ? { cost: execution.completion.cost as unknown as JsonValue } : {}),
      ...(execution.completion.service_tier ? { service_tier: execution.completion.service_tier } : {}),
    });
  }
  return chunks;
}

export function asChatCompletionStream(execution: ChatExecution, includeUsage = false): JsonObject[] {
  const id = execution.completion.id ?? `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const created = execution.completion.created ?? Math.floor(Date.now() / 1_000);
  const base = { id, object: "chat.completion.chunk", created, model: publicModelId(execution.model) };
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
  if (execution.completion.energy || execution.completion.cost || execution.completion.service_tier) {
    chunks.push({
      ...base,
      choices: [],
      ...(execution.completion.energy ? { energy: execution.completion.energy as unknown as JsonValue } : {}),
      ...(execution.completion.cost ? { cost: execution.completion.cost as unknown as JsonValue } : {}),
      ...(execution.completion.service_tier ? { service_tier: execution.completion.service_tier } : {}),
    });
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
