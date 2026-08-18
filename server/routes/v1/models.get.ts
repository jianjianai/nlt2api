import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireClientAuth } from "~/server/utils/http.ts";
import { portalClient } from "~/server/utils/portal-client.ts";
import { upstreamHttpError } from "~/server/utils/route-helpers.ts";

function asModel(model: Record<string, unknown>) {
  const id = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : undefined;
  if (!id) return undefined;
  return {
    id,
    object: "model",
    created: 0,
    owned_by: typeof model.provider === "string" ? model.provider : "neuralwatt",
  };
}

export default defineHandler(async (event) => {
  try {
    requireClientAuth(event.req);
    const models = (await portalClient.listModels()).map(asModel).filter((model): model is NonNullable<typeof model> => Boolean(model));
    return jsonResponse({ object: "list", data: models });
  } catch (error) {
    return openAIErrorResponse(upstreamHttpError(error));
  }
});
