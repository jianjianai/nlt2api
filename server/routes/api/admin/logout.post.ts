import { defineEventHandler } from "h3"
import { clearAdminSessionCookie } from "../../../utils/admin-auth"

export default defineEventHandler((event) => {
  clearAdminSessionCookie(event)
  return { ok: true }
})
