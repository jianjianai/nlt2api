import { defineEventHandler, sendRedirect } from "h3"
import { clearWebAccess } from "../../utils/web-access"

export default defineEventHandler((event) => {
  clearWebAccess(event)
  return sendRedirect(event, "/access")
})
