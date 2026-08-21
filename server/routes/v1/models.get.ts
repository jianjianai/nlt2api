import { defineHandler } from "nitro";
import { jsonResponse, openAIErrorResponse, requireClientAuth } from "~/server/utils/http.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { upstreamHttpError } from "~/server/utils/route-helpers.ts";

function asModel(id: string) {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "neuralwatt",
  };
}

export default defineHandler(async (event) => {
  try {
    requireClientAuth(event.req);
    const accounts = await stateStore.listAccounts();
    const ids = new Set<string>();
    for (const account of accounts) {
      for (const model of account.models) {
        ids.add(model);
      }
    }
    const models = [...ids].sort().map(asModel);
    return jsonResponse({ object: "list", data: models });
  } catch (error) {
    return openAIErrorResponse(upstreamHttpError(error));
  }
});
