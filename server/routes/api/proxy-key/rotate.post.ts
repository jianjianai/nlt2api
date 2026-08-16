import { defineEventHandler } from "h3"
import { requireProxyAuth } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { rotateProxyKey } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireProxyAuth(event)
    return { apiKey: await rotateProxyKey(), warning: "Store this key now; it is not returned by account APIs." }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
