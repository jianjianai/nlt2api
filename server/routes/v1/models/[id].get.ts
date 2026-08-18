import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireClientAuth, HttpError } from "~/server/utils/http.ts";
import { portalClient } from "~/server/utils/portal-client.ts";
import { upstreamHttpError } from "~/server/utils/route-helpers.ts";

export default defineHandler(async (event) => {
  try {
    requireClientAuth(event.req);
    const id = event.context.params?.id;
    if (!id) throw new HttpError(400, "Model id is required.", "invalid_request_error", "id");
    const model = (await portalClient.listModels()).find((candidate) => candidate.id === id || candidate.name === id);
    if (!model) throw new HttpError(404, "The requested model was not found.", "invalid_request_error", "model");
    return jsonResponse({
      id,
      object: "model",
      created: 0,
      owned_by: typeof model.provider === "string" ? model.provider : "neuralwatt",
    });
  } catch (error) {
    return openAIErrorResponse(upstreamHttpError(error));
  }
});
