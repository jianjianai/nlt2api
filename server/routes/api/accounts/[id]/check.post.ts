import { defineEventHandler, getRouterParam } from "h3"
import { requireAdminAuth } from "../../../../utils/admin-auth"
import { sendManagementError } from "../../../../utils/errors"
import { checkAccount } from "../../../../utils/proxy"

export default defineEventHandler(async (event) => {
  try {
    await requireAdminAuth(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Account id is required")
    return await checkAccount(id)
  } catch (error) {
    return sendManagementError(event, error)
  }
})
