import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireClientAuth, HttpError } from "~/server/utils/http.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { upstreamHttpError } from "~/server/utils/route-helpers.ts";

export default defineHandler(async (event) => {
  try {
    requireClientAuth(event.req);
    const id = event.context.params?.id;
    if (!id) throw new HttpError(400, "Model id is required.", "invalid_request_error", "id");
    const accounts = await stateStore.listAccounts();
    const supported = accounts.some((account) => account.models.includes(id));
    if (!supported) throw new HttpError(404, "The requested model was not found.", "invalid_request_error", "model");
    return jsonResponse({
      id,
      object: "model",
      created: 0,
      owned_by: "neuralwatt",
    });
  } catch (error) {
    return openAIErrorResponse(upstreamHttpError(error));
  }
});
