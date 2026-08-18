import { defineHandler } from "nitro";
import {
  asChatCompletion,
  asChatCompletionStream,
  executeChatRequest,
  stickyKeyFrom,
} from "~/server/utils/chat-service.ts";
import {
  HttpError,
  jsonResponse,
  openAIErrorResponse,
  readJsonObject,
  requireClientAuth,
} from "~/server/utils/http.ts";
import { openAISse } from "~/server/utils/upstream-stream.ts";
import { asJsonObject, recordDebug, upstreamHttpError } from "~/server/utils/route-helpers.ts";
import { requestDebugContext } from "~/server/utils/request-errors.ts";
import type { JsonObject } from "~/server/utils/types.ts";

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
      status: 200,
    });

    if (body.stream === true) {
      return openAISse(asChatCompletionStream(execution, streamOptions?.include_usage === true).map((data) => ({ data })));
    }
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
