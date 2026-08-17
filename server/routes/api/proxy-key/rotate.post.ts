import { defineEventHandler, readBody } from "h3"
import { requireAdminAuth } from "../../../utils/admin-auth"
import { sendManagementError } from "../../../utils/errors"
import { rotateProxyKey, setProxyKey } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireAdminAuth(event)
    // Empty body keeps the old behaviour: generate a random key.
    const body = await readBody<{ apiKey?: unknown }>(event).catch(() => undefined)
    const requested = typeof body?.apiKey === "string" ? body.apiKey.trim() : ""
    const apiKey = requested ? await setProxyKey(requested) : await rotateProxyKey()
    return { apiKey, warning: "Store this key now; it is not returned by account APIs." }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
