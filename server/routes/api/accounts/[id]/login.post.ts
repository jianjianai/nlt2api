import { defineEventHandler, getRouterParam } from "h3"
import { requireAdmin } from "../../../../v2/http/auth"
import { sendApiError } from "../../../../v2/http/errors"
import { ApiError } from "../../../../v2/shared/errors"
import { getRuntime } from "../../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const id = getRouterParam(event, "id")
    if (!id) throw new ApiError("Account not found", { status: 404, code: "account_not_found" })
    await runtime.accountPool.loginAccount(id)
    const account = (await runtime.accounts.listAccounts()).find((item) => item.id === id)
    return { ok: true, account }
  } catch (error) {
    return sendApiError(event, error)
  }
})
