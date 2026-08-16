import { defineEventHandler } from "h3"
import { requireProxyAuth } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { listAccounts } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireProxyAuth(event)
    return { accounts: await listAccounts() }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
