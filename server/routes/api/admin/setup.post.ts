import { defineEventHandler } from "h3"
import { assertSameOrigin, requestIdentifier, setAdminCookie } from "../../../v2/http/auth"
import { readJsonBody } from "../../../v2/http/body"
import { sendApiError } from "../../../v2/http/errors"
import { allowKeys, objectBody } from "../../../v2/http/validation"
import { ApiError } from "../../../v2/shared/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    assertSameOrigin(event)
    const runtime = await getRuntime()
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["bootstrapToken", "password"])
    const identifier = requestIdentifier(event)
    runtime.adminSecurity.loginLimiter.assertAllowed(identifier)
    if (!runtime.bootstrap.verify(body.bootstrapToken)) {
      runtime.adminSecurity.loginLimiter.recordFailure(identifier)
      throw new ApiError("The administrator setup token is invalid", {
        status: 401,
        code: "invalid_bootstrap_token",
        type: "authentication_error"
      })
    }
    const session = await runtime.adminSecurity.initializePassword(body.password)
    runtime.adminSecurity.loginLimiter.recordSuccess(identifier)
    setAdminCookie(event, session)
    return { authenticated: true, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() }
  } catch (error) {
    return sendApiError(event, error)
  }
})
