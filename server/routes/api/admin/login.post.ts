import { defineEventHandler, readBody } from "h3"
import { checkAdminPassword, createSessionToken, setAdminSessionCookie } from "../../../utils/admin-auth"
import { AppError, sendManagementError } from "../../../utils/errors"
import { getAdminSessionSecret } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<{ password?: unknown }>(event)
    const password = typeof body?.password === "string" ? body.password : ""
    const result = await checkAdminPassword(password)
    if (result === "unset") {
      throw new AppError("Admin password is not configured; complete setup first", 403, "admin_password_not_set")
    }
    if (result !== "ok") {
      throw new AppError("密码错误", 401, "invalid_admin_password")
    }
    const { token, expiresAt } = createSessionToken(await getAdminSessionSecret())
    setAdminSessionCookie(event, token, expiresAt)
    return { ok: true }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
