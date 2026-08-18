import { defineEventHandler } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { readJsonBody } from "../../../v2/http/body"
import { sendApiError } from "../../../v2/http/errors"
import { allowKeys, objectBody } from "../../../v2/http/validation"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["label", "email", "password", "cookie", "enabled"])
    const account = await runtime.accounts.createAccount({
      label: body.label as string,
      email: body.email as string,
      password: body.password as string,
      ...(body.cookie !== undefined ? { cookie: body.cookie as string | null } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {})
    })
    return { account }
  } catch (error) {
    return sendApiError(event, error)
  }
})
