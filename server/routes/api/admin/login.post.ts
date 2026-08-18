import { defineEventHandler } from "h3"
import { assertSameOrigin, requestIdentifier, setAdminCookie } from "../../../v2/http/auth"
import { readJsonBody } from "../../../v2/http/body"
import { sendApiError } from "../../../v2/http/errors"
import { allowKeys, objectBody } from "../../../v2/http/validation"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    assertSameOrigin(event)
    const runtime = await getRuntime()
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["password"])
    const session = await runtime.adminSecurity.login(body.password, requestIdentifier(event))
    setAdminCookie(event, session)
    return { authenticated: true, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() }
  } catch (error) {
    return sendApiError(event, error)
  }
})
