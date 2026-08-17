import { defineEventHandler, getRouterParam } from "h3"
import { requireAdminAuth } from "../../../../utils/admin-auth"
import { sendManagementError } from "../../../../utils/errors"
import { ensurePortalLogin } from "../../../../utils/portal"
import { getAccount, recordAccountLogin, recordAccountStatus } from "../../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireAdminAuth(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Account id is required")
    const account = await getAccount(id)
    const cookie = await ensurePortalLogin(account)
    await recordAccountLogin(id, cookie)
    return { ok: true, status: "ready" }
  } catch (error) {
    const id = getRouterParam(event, "id")
    if (id) {
      await recordAccountStatus(id, "login_failed", error instanceof Error ? error.message : "login_failed")
    }
    return sendManagementError(event, error)
  }
})
