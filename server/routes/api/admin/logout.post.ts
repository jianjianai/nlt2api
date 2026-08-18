import { defineEventHandler } from "h3"
import { adminSessionToken, clearAdminCookie, csrfToken, requireAdmin } from "../../../v2/http/auth"
import { sendApiError } from "../../../v2/http/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    runtime.adminSecurity.logout(adminSessionToken(event), csrfToken(event))
    clearAdminCookie(event)
    return { ok: true }
  } catch (error) {
    clearAdminCookie(event)
    return sendApiError(event, error)
  }
})
