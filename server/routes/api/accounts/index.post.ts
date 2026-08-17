import { defineEventHandler, readBody } from "h3"
import { requireAdminAuth } from "../../../utils/admin-auth"
import { sendManagementError } from "../../../utils/errors"
import { createAccount } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireAdminAuth(event)
    const body = await readBody<{ label?: unknown; email?: unknown; password?: unknown }>(event)
    return { account: await createAccount({ label: String(body?.label ?? ""), email: String(body?.email ?? ""), password: String(body?.password ?? "") }) }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
