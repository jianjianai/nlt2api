import { defineHandler } from "nitro";
import { executeResponsesRequest } from "~/server/utils/responses-service.ts";
import { jsonResponse, openAIErrorResponse, readJsonObject, requireClientAuth } from "~/server/utils/http.ts";
import { openAISse } from "~/server/utils/upstream-stream.ts";
import { recordDebug, upstreamHttpError } from "~/server/utils/route-helpers.ts";
import { requestDebugContext } from "~/server/utils/request-errors.ts";
import type { JsonObject } from "~/server/utils/types.ts";

export default defineHandler(async (event) => {
  let body: JsonObject | undefined;
  try {
    requireClientAuth(event.req);
    body = await readJsonObject(event.req);
    const execution = await executeResponsesRequest(body);

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

    if (body.stream === true) {
      return openAISse(execution.streamEvents, { doneMarker: false });
    }
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
