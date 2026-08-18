import { defineEventHandler, getQuery, getRouterParam } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { sendApiError } from "../../../v2/http/errors"
import { expectedRevision } from "../../../v2/http/validation"
import { ApiError } from "../../../v2/shared/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const id = getRouterParam(event, "id")
    if (!id) throw new ApiError("Account not found", { status: 404, code: "account_not_found" })
    const rawRevision = getQuery(event).revision
    const revision = typeof rawRevision === "string" && rawRevision ? Number(rawRevision) : undefined
    await runtime.accounts.deleteAccount(id, { expectedRevision: expectedRevision(revision) })
    return { ok: true }
  } catch (error) {
    return sendApiError(event, error)
  }
})
