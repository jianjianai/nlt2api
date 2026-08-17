import { defineEventHandler } from "h3"
import { requireWebAccessSession } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { listProxyKeys } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    return { keys: await listProxyKeys() }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
