import { defineEventHandler } from "h3"
import { adminSessionToken } from "../../../v2/http/auth"
import { sendApiError } from "../../../v2/http/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    const session = runtime.adminSecurity.sessions.describe(adminSessionToken(event))
    return {
      authenticated: Boolean(session),
      hasPassword: await runtime.adminSecurity.hasPassword(),
      bootstrapConfigured: runtime.bootstrap.configured,
      ...(session ? { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() } : {})
    }
  } catch (error) {
    return sendApiError(event, error)
  }
})
