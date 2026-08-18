import { defineEventHandler, getRouterParam } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { readJsonBody } from "../../../v2/http/body"
import { sendApiError } from "../../../v2/http/errors"
import { allowKeys, expectedRevision, objectBody } from "../../../v2/http/validation"
import { ApiError } from "../../../v2/shared/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const id = getRouterParam(event, "id")
    if (!id) throw new ApiError("Account not found", { status: 404, code: "account_not_found" })
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["revision", "label", "email", "password", "cookie", "enabled"])
    const account = await runtime.accounts.updateAccount(id, {
      ...(body.label !== undefined ? { label: body.label as string } : {}),
      ...(body.email !== undefined ? { email: body.email as string } : {}),
      ...(body.password !== undefined ? { password: body.password as string } : {}),
      ...(body.cookie !== undefined ? { cookie: body.cookie as string | null } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {})
    }, { expectedRevision: expectedRevision(body.revision) })
    return { account }
  } catch (error) {
    return sendApiError(event, error)
  }
})
