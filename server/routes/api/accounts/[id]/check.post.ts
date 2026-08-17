import { defineEventHandler, getRouterParam } from "h3"
import { requireManagementAuth } from "../../../../utils/auth"
import { sendManagementError } from "../../../../utils/errors"
import { checkAccount } from "../../../../utils/proxy"

export default defineEventHandler(async (event) => {
  try {
    await requireManagementAuth(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Account id is required")
    return await checkAccount(id)
  } catch (error) {
    return sendManagementError(event, error)
  }
})
