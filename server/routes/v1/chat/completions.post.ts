import { defineHandler } from "nitro";
import {
  asChatCompletion,
  assertModelSupported,
  chatChunksFromUpstreamFrame,
  ClientDisconnectedError,
  createChatStreamState,
  executeChatRequest,
  finishChatStream,
  modelFromRequest,
  startChatStream,
  stickyKeyFrom,
  validateChatRequest,
} from "~/server/utils/chat-service.ts";
import {
  HttpError,
  jsonResponse,
  openAIErrorResponse,
  readJsonObjectWithRaw,
  requireClientAuth,
} from "~/server/utils/http.ts";
import { openAIStreamingSse, type SseEntry } from "~/server/utils/upstream-stream.ts";
import { recordDebug, upstreamHttpError } from "~/server/utils/route-helpers.ts";
import { requestDebugContext } from "~/server/utils/request-errors.ts";
import type { DebugRawBody, JsonObject } from "~/server/utils/types.ts";

function jsonDebugBody(body: string): DebugRawBody {
  return { contentType: "application/json", body };
}

function jsonDebugValue(value: JsonObject): DebugRawBody {
  return jsonDebugBody(JSON.stringify(value));
}

function sseDebugBody(entries: SseEntry[]): DebugRawBody {
  const body = entries.map((entry) => `${entry.event ? `event: ${entry.event}\n` : ""}data: ${JSON.stringify(entry.data)}\n\n`).join("");
  return { contentType: "text/event-stream", body: `${body}data: [DONE]\n\n` };
}

function streamErrorData(error: unknown): JsonObject {
  const mapped = upstreamHttpError(error);
  return {
    error: {
      message: mapped.message,
      type: mapped.type,
      ...(mapped.param ? { param: mapped.param } : {}),
      ...(mapped.code ? { code: mapped.code } : {}),
    },
  };
}

export default defineHandler(async (event) => {
  let body: JsonObject | undefined;
  let clientRequest: DebugRawBody | undefined;
  try {
    const principal = await requireClientAuth(event.req);
    const groupId = principal.scope === "group" ? principal.groupId : undefined;
    const parsedRequest = await readJsonObjectWithRaw(event.req);
    body = parsedRequest.body;
    clientRequest = jsonDebugBody(parsedRequest.raw);
    const streamOptions = body.stream_options && typeof body.stream_options === "object" && !Array.isArray(body.stream_options)
      ? body.stream_options as JsonObject
      : undefined;
    if (body.stream_options !== undefined && !streamOptions) {
      throw new HttpError(400, "`stream_options` must be an object.", "invalid_request_error", "stream_options");
    }
    if (streamOptions?.include_usage !== undefined && typeof streamOptions.include_usage !== "boolean") {
      throw new HttpError(400, "`stream_options.include_usage` must be a boolean.", "invalid_request_error", "stream_options.include_usage");
    }
    const requestBody = body;
    // Keep client-shape errors as ordinary HTTP 4xx responses. Once the SSE
    // headers are committed, only runtime/upstream failures can use SSE errors.
    // The validated artifacts are forwarded so execution does not re-validate.
    const validated = validateChatRequest(requestBody);
    await assertModelSupported(validated.model, groupId);
    if (body.stream === true) {
      const includeUsage = streamOptions?.include_usage === true;
      const state = createChatStreamState(requestBody);
      return openAIStreamingSse(async (emit, signal) => {
        const clientEvents: SseEntry[] = [];
        const trackedEmit = async (entry: SseEntry): Promise<void> => {
          clientEvents.push(entry);
          await emit(entry);
        };
        try {
          // Match the normal OpenAI lifecycle: the client can render an
          // assistant turn immediately, before the portal's first token.
          await trackedEmit({ data: startChatStream(state) });
          const execution = await executeChatRequest(requestBody, {
            stickyKey: stickyKeyFrom(event.req, requestBody),
            groupId,
            stream: true,
            signal,
            validated,
            onUpstreamFrame: async (frame) => {
              const chunks = chatChunksFromUpstreamFrame(frame, state, includeUsage);
              for (const chunk of chunks) {
                await trackedEmit({ data: chunk });
              }
              return chunks.length > 0;
            },
            onRepairReasoning: async (reasoning) => {
              const chunks = chatChunksFromUpstreamFrame({
                choices: [{ delta: { role: "assistant", ...reasoning } }],
              }, state, false);
              for (const chunk of chunks) {
                await trackedEmit({ data: chunk });
              }
            },
          });

          // Tool turns are deliberately buffered for JSON/schema validation;
          // non-SSE portal fallbacks also reach this path. finishChatStream
          // fills only data that was not already forwarded, avoiding duplicate
          // role/content deltas in both cases.
          for (const chunk of finishChatStream(execution, state, includeUsage)) {
            await trackedEmit({ data: chunk });
          }

          const completion = asChatCompletion(execution);
          await recordDebug({
            endpoint: "/v1/chat/completions",
            accountId: execution.account.id,
            accountLabel: execution.account.label,
            clientRequest: clientRequest!,
            clientResponse: sseDebugBody(clientEvents),
            upstreamCalls: execution.upstreamCalls,
            ...(execution.toolCallAdapter ? { toolCallAdapter: execution.toolCallAdapter } : {}),
            status: 200,
          });
        } catch (error) {
          if (error instanceof ClientDisconnectedError) {
            return;
          }
          const mapped = upstreamHttpError(error);
          const context = requestDebugContext(error);
          await recordDebug({
            endpoint: "/v1/chat/completions",
            accountId: context.accountId,
            accountLabel: context.accountLabel,
            clientRequest: clientRequest!,
            clientResponse: sseDebugBody([...clientEvents, { data: streamErrorData(error) }]),
            ...(context.upstreamCalls ? { upstreamCalls: context.upstreamCalls } : {}),
            ...(context.toolCallAdapter ? { toolCallAdapter: context.toolCallAdapter } : {}),
            status: mapped.status,
            error: mapped.message,
          });
          throw error;
        }
      }, {
        onError: (error) => ({ data: streamErrorData(error) }),
      });
    }
    const execution = await executeChatRequest(body, {
      stickyKey: stickyKeyFrom(event.req, body),
      groupId,
      validated,
    });
    const completion = asChatCompletion(execution);

    await recordDebug({
      endpoint: "/v1/chat/completions",
      accountId: execution.account.id,
      accountLabel: execution.account.label,
      clientRequest: clientRequest!,
      clientResponse: jsonDebugValue(completion),
      upstreamCalls: execution.upstreamCalls,
      ...(execution.toolCallAdapter ? { toolCallAdapter: execution.toolCallAdapter } : {}),
      status: 200,
    });

    return jsonResponse(completion);
  } catch (error) {
    const mapped = upstreamHttpError(error);
    if (body && clientRequest) {
      const context = requestDebugContext(error);
      await recordDebug({
        endpoint: "/v1/chat/completions",
        accountId: context.accountId,
        accountLabel: context.accountLabel,
        clientRequest,
        clientResponse: jsonDebugValue(streamErrorData(error)),
        ...(context.upstreamCalls ? { upstreamCalls: context.upstreamCalls } : {}),
        ...(context.toolCallAdapter ? { toolCallAdapter: context.toolCallAdapter } : {}),
        status: mapped.status,
        error: mapped.message,
      });
    }
    return openAIErrorResponse(mapped);
  }
});
