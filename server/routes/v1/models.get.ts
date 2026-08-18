import { defineEventHandler } from "h3"
import { requireInferenceKey } from "../../v2/http/auth"
import { sendApiError } from "../../v2/http/errors"
import { getRuntime } from "../../v2/runtime"
import { isJsonObject } from "../../v2/shared/json"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    await requireInferenceKey(event, runtime)
    const catalog = await runtime.settings.getModelCatalog()
    return {
      object: "list",
      data: catalog.data.flatMap((value) => {
        if (!isJsonObject(value) || typeof value.id !== "string" || !value.id) return []
        return [{
          id: value.id,
          object: "model",
          created: typeof value.created === "number" && Number.isFinite(value.created) ? Math.floor(value.created) : 0,
          owned_by: typeof value.owned_by === "string" && value.owned_by ? value.owned_by : "neuralwatt"
        }]
      })
    }
  } catch (error) {
    return sendApiError(event, error)
  }
})
