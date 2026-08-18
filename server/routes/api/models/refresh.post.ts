import { defineEventHandler } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { sendApiError } from "../../../v2/http/errors"
import { getRuntime } from "../../../v2/runtime"
import { isJsonObject, type JsonObject } from "../../../v2/shared/json"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const remote = await runtime.portal.modelCatalog()
    const seen = new Set<string>()
    const data = (remote.body.data as unknown[]).flatMap((value): JsonObject[] => {
      if (!isJsonObject(value) || typeof value.id !== "string" || !value.id) return []
      if (value.id.toLowerCase().endsWith("-flex") || value.id === "deepseek-ai/DeepSeek-V4-Flash" || seen.has(value.id)) return []
      seen.add(value.id)
      return [value]
    })
    return { models: await runtime.settings.replaceModelCatalog({ data, scope: remote.scope }) }
  } catch (error) {
    return sendApiError(event, error)
  }
})
