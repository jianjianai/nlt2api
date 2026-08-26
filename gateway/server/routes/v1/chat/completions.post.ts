import { defineHandler } from "nitro";
import { toHttpError } from "~/server/utils/error-mapping.ts";
import { openAIErrorResponse, readJsonObject, requireClientAuth } from "~/server/utils/http.ts";
import { validateChatRequest } from "~/server/utils/forward-service.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

/**
 * Transparent OpenAI-compatible passthrough. The body is forwarded untouched;
 * the gateway only supplies the (proxy, ticket) pair the upstream requires.
 */
export default defineHandler(async (event) => {
  try {
    requireClientAuth(event.req);
    const body = await readJsonObject(event.req);
    const { stream } = validateChatRequest(body);
    const upstream = await gatewayRuntime().forward.chat(body, event.req.signal);

    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": upstream.headers.get("content-type")
        ?? (stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8"),
    });
    if (stream) {
      headers.set("Connection", "keep-alive");
      headers.set("X-Accel-Buffering", "no");
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return openAIErrorResponse(toHttpError(error));
  }
});
