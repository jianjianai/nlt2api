import { defineEventHandler } from "h3"
import { requireAdminAuth } from "../../../utils/admin-auth"
import { sendManagementError } from "../../../utils/errors"
import { listAccounts } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireAdminAuth(event)
    return { accounts: await listAccounts() }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
