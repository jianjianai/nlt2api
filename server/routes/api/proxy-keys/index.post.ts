import { defineEventHandler, readBody } from "h3"
import { requireWebAccessSession } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { createProxyKey } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    const body = await readBody<{ label?: unknown }>(event)
    return { key: await createProxyKey({ label: typeof body?.label === "string" ? body.label : "" }) }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
