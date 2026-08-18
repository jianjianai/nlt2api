import { defineEventHandler, getRouterParam } from "h3"
import { requireWebAccessSession } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { getDebugTraceDetail } from "../../../utils/debug-history"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Debug trace id is required")
    return await getDebugTraceDetail(id)
  } catch (error) {
    return sendManagementError(event, error)
  }
})
