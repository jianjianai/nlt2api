import { defineEventHandler, getRequestURL, sendRedirect } from "h3"
import { hasWebAccessSession } from "../utils/web-access"

const protectedPaths = new Set([
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/debug",
  "/debug.html",
  "/debug.js",
  "/debug.css"
])

export default defineEventHandler((event) => {
  const url = getRequestURL(event)
  if (!protectedPaths.has(url.pathname) || hasWebAccessSession(event)) return

  return sendRedirect(event, `/access?next=${encodeURIComponent(url.pathname)}`)
})
