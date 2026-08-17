import { defineEventHandler, getRouterParam, readBody } from "h3"
import { requireWebAccessSession } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { updateProxyKey } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Proxy key id is required")
    const body = await readBody<{ label?: unknown; enabled?: unknown }>(event)
    return {
      key: await updateProxyKey(id, {
        label: typeof body?.label === "string" ? body.label : undefined,
        enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined
      })
    }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
