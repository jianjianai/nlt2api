import { randomUUID } from "node:crypto";
import { accountScheduler } from "~/server/utils/account-scheduler.ts";
import { defineHandler } from "nitro";
import {
  assertModelSupported,
  ClientDisconnectedError,
  executeChatRequest,
  modelFromRequest,
  resolveToolCallPolicy,
  stickyKeyFrom,
  validateChatRequest,
} from "~/server/utils/chat-service.ts";
import {
  jsonResponse,
  openAIErrorResponse,
  readJsonObjectWithRaw,
  requireClientAuth,
} from "~/server/utils/http.ts";
import {
  chatChunksFromUpstreamFrame,
  createChatStreamState,
  createResponseStreamState,
  failedResponseEvent,
  finishChatStream,
  finishResponseStream,
  persistResponseState,
  responseEventsFromChatChunk,
  responseFromExecution,
  startResponseStream,
  validateResponseRequest,
} from "~/server/utils/response-api.ts";
import { recordDebug, upstreamHttpError } from "~/server/utils/route-helpers.ts";
import { requestDebugContext } from "~/server/utils/request-errors.ts";
import { openAIStreamingSse, type SseEntry } from "~/server/utils/upstream-stream.ts";
import type { DebugRawBody, JsonObject, ResponseAccessScope } from "~/server/utils/types.ts";

function jsonDebugBody(body: string): DebugRawBody {
  return { contentType: "application/json", body };
}

function jsonDebugValue(value: JsonObject): DebugRawBody {
  return jsonDebugBody(JSON.stringify(value));
}

function sseDebugBody(entries: SseEntry[]): DebugRawBody {
  const body = entries.map((entry) => `${entry.event ? `event: ${entry.event}\n` : ""}data: ${JSON.stringify(entry.data)}\n\n`).join("");
  return { contentType: "text/event-stream", body };
}

function errorShape(error: unknown): { status: number; code: string; message: string } {
  const mapped = upstreamHttpError(error);
  return { status: mapped.status, code: mapped.code ?? mapped.type, message: mapped.message };
}

export default defineHandler(async (event) => {
  let body: JsonObject | undefined;
  let clientRequest: DebugRawBody | undefined;
  try {
    const principal = await requireClientAuth(event.req);
    const groupId = principal.scope === "group" ? principal.groupId : undefined;
    const access: ResponseAccessScope = groupId ? { scope: "group", groupId } : { scope: "global" };
    const parsedRequest = await readJsonObjectWithRaw(event.req);
    body = parsedRequest.body;
    clientRequest = jsonDebugBody(parsedRequest.raw);
    const requestBody = body;
    // Convert and validate before any SSE headers are committed so client
    // shape errors stay ordinary HTTP 4xx responses, exactly like the chat
    // endpoint. Execution reuses the validated chat request.
    const { chatRequest, context } = await validateResponseRequest(requestBody, access);
    const toolCallPolicy = await resolveToolCallPolicy(modelFromRequest(chatRequest));
    const validated = validateChatRequest(chatRequest, toolCallPolicy);
    await assertModelSupported(validated.model, groupId);

    if (requestBody.stream === true) {
      const streamState = createResponseStreamState(context);
      const chatState = createChatStreamState(chatRequest);
      return openAIStreamingSse(async (emit, signal) => {
        const clientEvents: SseEntry[] = [];
        const trackedEmit = async (entry: SseEntry): Promise<void> => {
          clientEvents.push(entry);
          await emit(entry);
        };
        try {
          for (const streamEvent of startResponseStream(streamState)) {
            await trackedEmit({ event: streamEvent.event, data: streamEvent.data });
          }
          const execution = await executeChatRequest(chatRequest, {
            endpoint: "/v1/responses",
            stickyKey: stickyKeyFrom(event.req, chatRequest),
            groupId,
            stream: true,
            signal,
            validated,
            onUpstreamFrame: async (frame) => {
              const chunks = chatChunksFromUpstreamFrame(frame, chatState, true);
              for (const chunk of chunks) {
                for (const streamEvent of responseEventsFromChatChunk(chunk, streamState)) {
                  await trackedEmit({ event: streamEvent.event, data: streamEvent.data });
                }
              }
              return chunks.length > 0;
            },
            onRepairReasoning: async (reasoning) => {
              const chunks = chatChunksFromUpstreamFrame({
                choices: [{ delta: { role: "assistant", ...reasoning } }],
              }, chatState, false);
              for (const chunk of chunks) {
                for (const streamEvent of responseEventsFromChatChunk(chunk, streamState)) {
                  await trackedEmit({ event: streamEvent.event, data: streamEvent.data });
                }
              }
            },
          });

          // Keep the chat state machine consistent through the terminal
          // frames; its fallback deltas cover JSON-fallback turns, while the
          // finish helper releases validated tool calls and the completed
          // response object.
          for (const chunk of finishChatStream(execution, chatState, true)) {
            for (const streamEvent of responseEventsFromChatChunk(chunk, streamState)) {
              await trackedEmit({ event: streamEvent.event, data: streamEvent.data });
            }
          }
          for (const streamEvent of finishResponseStream(execution, streamState)) {
            await trackedEmit({ event: streamEvent.event, data: streamEvent.data });
          }

          accountScheduler.bindStickyKey(execution.account.id, `response:${streamState.id}`);
          await persistResponseState(streamState.id, execution, context, access);
          await recordDebug({
            endpoint: "/v1/responses",
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
          const mapped = errorShape(error);
          const contextInfo = requestDebugContext(error);
          const failed = failedResponseEvent(streamState, { code: mapped.code, message: mapped.message });
          await recordDebug({
            endpoint: "/v1/responses",
            accountId: contextInfo.accountId,
            accountLabel: contextInfo.accountLabel,
            clientRequest: clientRequest!,
            clientResponse: sseDebugBody([...clientEvents, { event: failed.event, data: failed.data }]),
            ...(contextInfo.upstreamCalls ? { upstreamCalls: contextInfo.upstreamCalls } : {}),
            ...(contextInfo.toolCallAdapter ? { toolCallAdapter: contextInfo.toolCallAdapter } : {}),
            status: mapped.status,
            error: mapped.message,
          });
          throw error;
        }
      }, {
        doneMarker: false,
        onError: (error) => {
          const mapped = errorShape(error);
          const failed = failedResponseEvent(streamState, { code: mapped.code, message: mapped.message });
          return { event: failed.event, data: failed.data };
        },
      });
    }

    const execution = await executeChatRequest(chatRequest, {
      endpoint: "/v1/responses",
      stickyKey: stickyKeyFrom(event.req, chatRequest),
      groupId,
      validated,
    });
    const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
    accountScheduler.bindStickyKey(execution.account.id, `response:${responseId}`);
    const response = responseFromExecution(execution, context, responseId, Math.floor(Date.now() / 1_000));
    await persistResponseState(responseId, execution, context, access);

    await recordDebug({
      endpoint: "/v1/responses",
      accountId: execution.account.id,
      accountLabel: execution.account.label,
      clientRequest,
      clientResponse: jsonDebugValue(response),
      upstreamCalls: execution.upstreamCalls,
      ...(execution.toolCallAdapter ? { toolCallAdapter: execution.toolCallAdapter } : {}),
      status: 200,
    });

    return jsonResponse(response);
  } catch (error) {
    const mapped = upstreamHttpError(error);
    if (body && clientRequest) {
      const contextInfo = requestDebugContext(error);
      await recordDebug({
        endpoint: "/v1/responses",
        accountId: contextInfo.accountId,
        accountLabel: contextInfo.accountLabel,
        clientRequest,
        clientResponse: jsonDebugValue({
          error: {
            message: mapped.message,
            type: mapped.type,
            ...(mapped.param ? { param: mapped.param } : {}),
            ...(mapped.code ? { code: mapped.code } : {}),
          },
        }),
        ...(contextInfo.upstreamCalls ? { upstreamCalls: contextInfo.upstreamCalls } : {}),
        ...(contextInfo.toolCallAdapter ? { toolCallAdapter: contextInfo.toolCallAdapter } : {}),
        status: mapped.status,
        error: mapped.message,
      });
    }
    return openAIErrorResponse(mapped);
  }
});
