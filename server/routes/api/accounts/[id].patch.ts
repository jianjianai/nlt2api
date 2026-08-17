import { defineEventHandler, getRouterParam, readBody } from "h3"
import { requireAdminAuth } from "../../../utils/admin-auth"
import { sendManagementError } from "../../../utils/errors"
import { updateAccount } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireAdminAuth(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Account id is required")
    const body = await readBody<{ label?: unknown; email?: unknown; password?: unknown; enabled?: unknown }>(event)
    return {
      account: await updateAccount(id, {
        label: typeof body?.label === "string" ? body.label : undefined,
        email: typeof body?.email === "string" ? body.email : undefined,
        password: typeof body?.password === "string" ? body.password : undefined,
        enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined
      })
    }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
