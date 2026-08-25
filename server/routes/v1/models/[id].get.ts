import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireClientAuth, HttpError } from "~/server/utils/http.ts";
import { modelIdMatches, publicModelId } from "~/server/utils/model-id.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { upstreamHttpError } from "~/server/utils/route-helpers.ts";

export default defineHandler(async (event) => {
  try {
    const principal = await requireClientAuth(event.req);
    const id = event.context.params?.id;
    if (!id) throw new HttpError(400, "Model id is required.", "invalid_request_error", "id");
    const accounts = (await stateStore.listAccounts())
      .filter((account) => account.enabled)
      .filter((account) => principal.scope === "global" || account.groupIds.includes(principal.groupId));
    const supported = accounts.some((account) => account.models.some((model) => modelIdMatches(model, id)));
    if (!supported) throw new HttpError(404, "The requested model was not found.", "invalid_request_error", "model");
    return jsonResponse({
      id: publicModelId(id),
      object: "model",
      created: 0,
      owned_by: "deepinfra",
    });
  } catch (error) {
    return openAIErrorResponse(upstreamHttpError(error));
  }
});
