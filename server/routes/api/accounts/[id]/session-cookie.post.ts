import { defineEventHandler, getRouterParam, readBody } from "h3"
import { requireManagementAuth } from "../../../../utils/auth"
import { sendManagementError } from "../../../../utils/errors"
import { setAccountCookie } from "../../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireManagementAuth(event)
    const id = getRouterParam(event, "id")
    if (!id) throw new Error("Account id is required")
    const body = await readBody<{ cookie?: unknown }>(event)
    if (typeof body?.cookie !== "string") throw new Error("cookie is required")
    return { account: await setAccountCookie(id, body.cookie) }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
