import { randomUUID } from "node:crypto";
import { defineHandler } from "nitro";
import { ClientDisconnectedError } from "~/server/utils/chat-service.ts";
import { responseEnvelopeFields } from "~/server/utils/responses-compat.ts";
import { executeResponsesRequest, prepareResponsesRequest } from "~/server/utils/responses-service.ts";
import { jsonResponse, openAIErrorResponse, readJsonObject, requireClientAuth } from "~/server/utils/http.ts";
import { openAIStreamingSse } from "~/server/utils/upstream-stream.ts";
import { recordDebug, upstreamHttpError } from "~/server/utils/route-helpers.ts";
import { requestDebugContext } from "~/server/utils/request-errors.ts";
import type { JsonObject } from "~/server/utils/types.ts";

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
  try {
    requireClientAuth(event.req);
    body = await readJsonObject(event.req);
    const requestBody = body;
    if (requestBody.stream === true) {
      const prepared = await prepareResponsesRequest(requestBody);
      const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
      const createdAt = Math.floor(Date.now() / 1_000);
      let nextSequenceNumber = 0;
      return openAIStreamingSse(async (emit, signal) => {
        const trackedEmit = async (entry: { event?: string; data: unknown }) => {
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
            clientRequest: requestBody,
            upstreamRequest: execution.upstreamRequest,
            upstreamResponse: execution.upstreamResponse,
            clientResponse: execution.response,
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
            endpoint: "/v1/responses",
            clientRequest: requestBody,
            ...context,
            status: mapped.status,
            error: mapped.message,
          });
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
      clientRequest: body,
      upstreamRequest: execution.upstreamRequest,
      upstreamResponse: execution.upstreamResponse,
      clientResponse: execution.response,
      ...(execution.toolCallAdapter ? { toolCallAdapter: execution.toolCallAdapter } : {}),
      status: 200,
    });

    return jsonResponse(execution.response);
  } catch (error) {
    const mapped = upstreamHttpError(error);
    if (body) {
      const context = requestDebugContext(error);
      await recordDebug({
        endpoint: "/v1/responses",
        clientRequest: body,
        ...context,
        status: mapped.status,
        error: mapped.message,
      });
    }
    return openAIErrorResponse(mapped);
  }
});
