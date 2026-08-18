import { defineEventHandler } from "h3"
import { requireWebAccessSession } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { clearDebugHistory } from "../../../utils/debug-history"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    return { ok: true, cleared: await clearDebugHistory() }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
