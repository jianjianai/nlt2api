import { defineEventHandler, getCookie } from "h3"
import { ADMIN_SESSION_COOKIE, hasAdminPassword, verifySessionToken } from "../../../utils/admin-auth"
import { getAdminSessionSecret } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  const token = getCookie(event, ADMIN_SESSION_COOKIE)
  const authenticated = token ? verifySessionToken(token, await getAdminSessionSecret()) : false
  return { authenticated, hasPassword: await hasAdminPassword() }
})
