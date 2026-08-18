import { defineEventHandler } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { sendApiError } from "../../../v2/http/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    return { ok: true, deletedCount: runtime.requestLogs.clear() }
  } catch (error) {
    return sendApiError(event, error)
  }
})
