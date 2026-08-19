import { defineHandler } from "nitro";
import {
  asChatCompletion,
  chatChunksFromUpstreamFrame,
  ClientDisconnectedError,
  createChatStreamState,
  executeChatRequest,
  finishChatStream,
  startChatStream,
  stickyKeyFrom,
  validateChatRequest,
} from "~/server/utils/chat-service.ts";
import {
  HttpError,
  jsonResponse,
  openAIErrorResponse,
  readJsonObject,
  requireClientAuth,
} from "~/server/utils/http.ts";
import { openAIStreamingSse } from "~/server/utils/upstream-stream.ts";
import { asJsonObject, recordDebug, upstreamHttpError } from "~/server/utils/route-helpers.ts";
import { requestDebugContext } from "~/server/utils/request-errors.ts";
import type { JsonObject } from "~/server/utils/types.ts";

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
  try {
    requireClientAuth(event.req);
    body = await readJsonObject(event.req);
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
    validateChatRequest(requestBody);
    if (body.stream === true) {
      const includeUsage = streamOptions?.include_usage === true;
      const state = createChatStreamState(requestBody);
      return openAIStreamingSse(async (emit, signal) => {
        try {
          // Match the normal OpenAI lifecycle: the client can render an
          // assistant turn immediately, before the portal's first token.
          await emit({ data: startChatStream(state) });
          const execution = await executeChatRequest(requestBody, {
            stickyKey: stickyKeyFrom(event.req, requestBody),
            stream: true,
            signal,
            onUpstreamFrame: async (frame) => {
              const chunks = chatChunksFromUpstreamFrame(frame, state, includeUsage);
              for (const chunk of chunks) {
                await emit({ data: chunk });
              }
              return chunks.length > 0;
            },
          });

          // Tool turns are deliberately buffered for JSON/schema validation;
          // non-SSE portal fallbacks also reach this path. finishChatStream
          // fills only data that was not already forwarded, avoiding duplicate
          // role/content deltas in both cases.
          for (const chunk of finishChatStream(execution, state, includeUsage)) {
            await emit({ data: chunk });
          }

          const completion = asChatCompletion(execution);
          await recordDebug({
            endpoint: "/v1/chat/completions",
            accountId: execution.account.id,
            accountLabel: execution.account.label,
            clientRequest: requestBody,
            upstreamRequest: execution.upstreamRequest,
            upstreamResponse: asJsonObject(execution.completion),
            clientResponse: completion,
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
            clientRequest: requestBody,
            ...context,
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
    });
    const completion = asChatCompletion(execution);

    await recordDebug({
      endpoint: "/v1/chat/completions",
      accountId: execution.account.id,
      accountLabel: execution.account.label,
      clientRequest: body,
      upstreamRequest: execution.upstreamRequest,
      upstreamResponse: asJsonObject(execution.completion),
      clientResponse: completion,
      ...(execution.toolCallAdapter ? { toolCallAdapter: execution.toolCallAdapter } : {}),
      status: 200,
    });

    return jsonResponse(completion);
  } catch (error) {
    const mapped = upstreamHttpError(error);
    if (body) {
      const context = requestDebugContext(error);
      await recordDebug({
        endpoint: "/v1/chat/completions",
        clientRequest: body,
        ...context,
        status: mapped.status,
        error: mapped.message,
      });
    }
    return openAIErrorResponse(mapped);
  }
});
