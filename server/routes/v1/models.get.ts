import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireClientAuth } from "~/server/utils/http.ts";
import { publicModelId } from "~/server/utils/model-id.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { upstreamHttpError } from "~/server/utils/route-helpers.ts";

function asModel(id: string) {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "deepinfra",
  };
}

export default defineHandler(async (event) => {
  try {
    const principal = await requireClientAuth(event.req);
    const accounts = (await stateStore.listAccounts())
      .filter((account) => account.enabled)
      .filter((account) => principal.scope === "global" || account.groupIds.includes(principal.groupId));
    const ids = new Set<string>();
    for (const account of accounts) {
      for (const model of account.models) {
        ids.add(publicModelId(model));
      }
    }
    const models = [...ids].sort().map(asModel);
    return jsonResponse({ object: "list", data: models });
  } catch (error) {
    return openAIErrorResponse(upstreamHttpError(error));
  }
});
