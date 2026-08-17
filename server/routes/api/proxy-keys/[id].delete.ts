import { defineEventHandler, getRouterParam } from "h3"
import { requireWebAccessSession } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { deleteProxyKey } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Proxy key id is required")
    await deleteProxyKey(id)
    return { ok: true }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
