import { defineEventHandler, getRouterParam } from "h3"
import { requireProxyAuth } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { deleteAccount } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireProxyAuth(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Account id is required")
    await deleteAccount(id)
    return { ok: true }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
