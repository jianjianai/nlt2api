import { defineEventHandler, readBody } from "h3"
import { requireManagementAuth } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { createAccount } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireManagementAuth(event)
    const body = await readBody<{ label?: unknown; email?: unknown; password?: unknown }>(event)
    return { account: await createAccount({ label: String(body?.label ?? ""), email: String(body?.email ?? ""), password: String(body?.password ?? "") }) }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
