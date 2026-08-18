import { defineEventHandler, getRequestProtocol, getRequestURL, setResponseHeader } from "h3"

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ")

export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  setResponseHeader(event, "content-security-policy", CONTENT_SECURITY_POLICY)
  setResponseHeader(event, "x-content-type-options", "nosniff")
  setResponseHeader(event, "x-frame-options", "DENY")
  setResponseHeader(event, "referrer-policy", "no-referrer")
  setResponseHeader(event, "cross-origin-opener-policy", "same-origin")
  setResponseHeader(event, "cross-origin-resource-policy", "same-origin")
  setResponseHeader(event, "permissions-policy", "camera=(), microphone=(), geolocation=()")
  if (getRequestProtocol(event) === "https") {
    setResponseHeader(event, "strict-transport-security", "max-age=31536000; includeSubDomains")
  }
  if (path === "/" || path === "/index.html" || path.startsWith("/api/") || path.startsWith("/v1/")) {
    setResponseHeader(event, "cache-control", "no-store")
  }
})
