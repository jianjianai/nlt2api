import { defineEventHandler } from "h3"
import { adminSessionToken, csrfToken, requestIdentifier, requireAdmin, setAdminCookie } from "../../../v2/http/auth"
import { readJsonBody } from "../../../v2/http/body"
import { sendApiError } from "../../../v2/http/errors"
import { allowKeys, objectBody } from "../../../v2/http/validation"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["currentPassword", "password"])
    const session = await runtime.adminSecurity.changePassword({
      sessionToken: adminSessionToken(event),
      csrfToken: csrfToken(event),
      currentPassword: body.currentPassword,
      newPassword: body.password,
      limiterIdentifier: requestIdentifier(event)
    })
    setAdminCookie(event, session)
    return { ok: true, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() }
  } catch (error) {
    return sendApiError(event, error)
  }
})
