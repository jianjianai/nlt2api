import { defineHandler } from "nitro";
import { toHttpError } from "~/server/utils/error-mapping.ts";
import { HttpError, jsonResponse, openAIErrorResponse, requireClientAuth } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler(async (event) => {
  try {
    requireClientAuth(event.req);
    const id = decodeURIComponent(event.context.params?.id ?? "");
    const models = await gatewayRuntime().forward.models();
    const model = models.find((entry) => entry.id === id && entry.freeForAnonymous);
    if (!model) {
      throw new HttpError(404, `Model \`${id}\` is not available.`, "invalid_request_error", "model", "model_not_found");
    }
    return jsonResponse({
      id: model.id,
      object: "model",
      owned_by: "deepinfra",
      ...(model.contextLength ? { context_length: model.contextLength } : {}),
    });
  } catch (error) {
    return openAIErrorResponse(toHttpError(error));
  }
});
