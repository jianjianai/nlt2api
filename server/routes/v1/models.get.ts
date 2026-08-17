import { defineEventHandler, setResponseHeader } from "h3"
import { requireProxyAuth } from "../../utils/auth"
import { sendOpenAIError } from "../../utils/errors"
import { getSavedModelCatalog } from "../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireProxyAuth(event)
    const catalog = await getSavedModelCatalog()
    if (catalog.scope) setResponseHeader(event, "x-models-scope", catalog.scope)
    return { object: "list", scope: catalog.scope ?? "local", data: catalog.data }
  } catch (error) {
    return sendOpenAIError(event, error)
  }
})
