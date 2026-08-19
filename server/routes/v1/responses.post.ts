import { randomUUID } from "node:crypto";
import { defineHandler } from "nitro";
import { ClientDisconnectedError } from "~/server/utils/chat-service.ts";
import { responseEnvelopeFields } from "~/server/utils/responses-compat.ts";
import { executeResponsesRequest, prepareResponsesRequest } from "~/server/utils/responses-service.ts";
import { jsonResponse, openAIErrorResponse, readJsonObjectWithRaw, requireClientAuth } from "~/server/utils/http.ts";
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
  return {
    contentType: "text/event-stream",
    body: entries.map((entry) => `${entry.event ? `event: ${entry.event}\n` : ""}data: ${JSON.stringify(entry.data)}\n\n`).join(""),
  };
}

function streamErrorData(error: unknown, sequenceNumber: number): JsonObject {
  const mapped = upstreamHttpError(error);
  return {
    type: "error",
    code: mapped.code ?? "stream_error",
    message: mapped.message,
    param: mapped.param ?? null,
    sequence_number: sequenceNumber,
  };
}

export default defineHandler(async (event) => {
  let body: JsonObject | undefined;
  let clientRequest: DebugRawBody | undefined;
  try {
    requireClientAuth(event.req);
    const parsedRequest = await readJsonObjectWithRaw(event.req);
    body = parsedRequest.body;
    clientRequest = jsonDebugBody(parsedRequest.raw);
    const requestBody = body;
    if (requestBody.stream === true) {
      const prepared = await prepareResponsesRequest(requestBody);
      const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
      const createdAt = Math.floor(Date.now() / 1_000);
      let nextSequenceNumber = 0;
      return openAIStreamingSse(async (emit, signal) => {
        const clientEvents: SseEntry[] = [];
        const trackedEmit = async (entry: SseEntry): Promise<void> => {
          clientEvents.push(entry);
          const data = entry.data as JsonObject;
          if (typeof data.sequence_number === "number") {
            nextSequenceNumber = Math.max(nextSequenceNumber, data.sequence_number + 1);
          }
          await emit(entry);
        };
        try {
          const execution = await executeResponsesRequest(requestBody, {
            stream: true,
            emit: trackedEmit,
            signal,
            prepared,
            responseId,
            createdAt,
          });
          await recordDebug({
            endpoint: "/v1/responses",
            accountId: execution.accountId,
            accountLabel: execution.accountLabel,
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
          const failedResponse: JsonObject = {
            id: responseId,
            object: "response",
            created_at: createdAt,
            model: prepared.model,
            output: [],
            output_text: "",
            usage: null,
            ...responseEnvelopeFields(
              requestBody,
              prepared.tools,
              prepared.previousId,
              "completed",
              createdAt,
            ),
            status: "failed",
            completed_at: null,
            incomplete_details: null,
            error: {
              code: mapped.code ?? "upstream_error",
              message: mapped.message,
            },
          };
          await trackedEmit({
            event: "response.failed",
            data: {
              type: "response.failed",
              response: failedResponse,
              sequence_number: nextSequenceNumber,
            },
          });
          await recordDebug({
            endpoint: "/v1/responses",
            accountId: context.accountId,
            accountLabel: context.accountLabel,
            clientRequest: clientRequest!,
            clientResponse: sseDebugBody(clientEvents),
            ...(context.upstreamCalls ? { upstreamCalls: context.upstreamCalls } : {}),
            ...(context.toolCallAdapter ? { toolCallAdapter: context.toolCallAdapter } : {}),
            status: mapped.status,
            error: mapped.message,
          });
        }
      }, {
        doneMarker: false,
        onError: (error) => ({ event: "error", data: streamErrorData(error, nextSequenceNumber) }),
      });
    }
    const execution = await executeResponsesRequest(requestBody);

    await recordDebug({
      endpoint: "/v1/responses",
      accountId: execution.accountId,
      accountLabel: execution.accountLabel,
      clientRequest: clientRequest!,
      clientResponse: jsonDebugValue(execution.response),
      upstreamCalls: execution.upstreamCalls,
      ...(execution.toolCallAdapter ? { toolCallAdapter: execution.toolCallAdapter } : {}),
      status: 200,
    });

    return jsonResponse(execution.response);
  } catch (error) {
    const mapped = upstreamHttpError(error);
    if (body && clientRequest) {
      const context = requestDebugContext(error);
      await recordDebug({
        endpoint: "/v1/responses",
        accountId: context.accountId,
        accountLabel: context.accountLabel,
        clientRequest,
        clientResponse: jsonDebugValue({
          error: {
            message: mapped.message,
            type: mapped.type,
            ...(mapped.param ? { param: mapped.param } : {}),
            ...(mapped.code ? { code: mapped.code } : {}),
          },
        }),
        ...(context.upstreamCalls ? { upstreamCalls: context.upstreamCalls } : {}),
        ...(context.toolCallAdapter ? { toolCallAdapter: context.toolCallAdapter } : {}),
        status: mapped.status,
        error: mapped.message,
      });
    }
    return openAIErrorResponse(mapped);
  }
});
