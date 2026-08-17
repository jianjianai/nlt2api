import { defineEventHandler, readBody } from "h3"
import {
  checkAdminPassword,
  createSessionToken,
  hashAdminPassword,
  hasAdminPassword,
  requireAdminAuth,
  setAdminSessionCookie
} from "../../../utils/admin-auth"
import { requireProxyAuth } from "../../../utils/auth"
import { AppError, sendManagementError } from "../../../utils/errors"
import { rotateAdminSessionSecret, setAdminPasswordHash } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<{ currentPassword?: unknown; password?: unknown }>(event)
    const next = typeof body?.password === "string" ? body.password : ""
    if (next.length < 8) {
      throw new AppError("新密码至少 8 个字符", 400, "invalid_admin_password")
    }

    if (await hasAdminPassword()) {
      // Changing an existing password requires a valid session plus the current password.
      await requireAdminAuth(event)
      const current = typeof body?.currentPassword === "string" ? body.currentPassword : ""
      if ((await checkAdminPassword(current)) !== "ok") {
        throw new AppError("当前密码错误", 401, "invalid_admin_password")
      }
    } else {
      // First-run setup: prove ownership of the local proxy key printed in the terminal.
      await requireProxyAuth(event)
    }

    await setAdminPasswordHash(await hashAdminPassword(next))
    // Invalidate every other session, then keep this session logged in.
    const { token, expiresAt } = createSessionToken(await rotateAdminSessionSecret())
    setAdminSessionCookie(event, token, expiresAt)
    return { ok: true }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
