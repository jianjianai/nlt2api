import { defineHandler } from "nitro";
import { toHttpError } from "~/server/utils/error-mapping.ts";
import { jsonResponse, openAIErrorResponse, requireClientAuth } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler(async (event) => {
  try {
    requireClientAuth(event.req);
    const models = await gatewayRuntime().forward.models();
    return jsonResponse({
      object: "list",
      data: models.filter((model) => model.freeForAnonymous).map((model) => ({
        id: model.id,
        object: "model",
        owned_by: "deepinfra",
        ...(model.contextLength ? { context_length: model.contextLength } : {}),
      })),
    });
  } catch (error) {
    return openAIErrorResponse(toHttpError(error));
  }
});
