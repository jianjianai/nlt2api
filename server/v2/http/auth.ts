import {
  deleteCookie,
  getCookie,
  getHeader,
  getRequestHost,
  getRequestProtocol,
  setCookie,
  type H3Event
} from "h3"
import { ApiError } from "../shared/errors"
import { ADMIN_CSRF_HEADER, ADMIN_SESSION_COOKIE, adminSessionCookieOptions, clearAdminSessionCookieOptions, type AdminSession } from "../security/admin-sessions"
import type { RuntimeServices } from "../runtime"

export function adminSessionToken(event: H3Event): string | undefined {
  return getCookie(event, ADMIN_SESSION_COOKIE)
}

export function csrfToken(event: H3Event): string | undefined {
  return getHeader(event, ADMIN_CSRF_HEADER)
}

export function requestIdentifier(event: H3Event): string {
  const remote = event.node.req.socket.remoteAddress ?? "unknown"
  if (process.env.NEURALWATT_TRUST_PROXY === "1") {
    const forwarded = getHeader(event, "x-forwarded-for")?.split(",", 1)[0]?.trim()
    if (forwarded) return forwarded
  }
  return remote
}

export function requireAdmin(event: H3Event, runtime: RuntimeServices, mutation = false): void {
  const token = adminSessionToken(event)
  if (mutation) {
    assertSameOrigin(event)
    runtime.adminSecurity.assertMutationAuthorized(token, csrfToken(event))
  } else {
    runtime.adminSecurity.assertAuthenticated(token)
  }
}

export function setAdminCookie(event: H3Event, session: AdminSession): void {
  setCookie(event, ADMIN_SESSION_COOKIE, session.token, adminSessionCookieOptions(session.expiresAt, {
    secure: secureCookies(event)
  }))
}

export function clearAdminCookie(event: H3Event): void {
  deleteCookie(event, ADMIN_SESSION_COOKIE, clearAdminSessionCookieOptions({ secure: secureCookies(event) }))
}

export function bearerToken(event: H3Event): string | undefined {
  const header = getHeader(event, "authorization")
  const match = header?.match(/^Bearer\s+([^\s]+)$/i)
  return match?.[1]
}

export async function requireInferenceKey(event: H3Event, runtime: RuntimeServices): Promise<void> {
  const token = bearerToken(event)
  if (token && await runtime.inferenceKeys.verify(token)) return
  throw new ApiError("A valid inference Bearer key is required", {
    status: 401,
    code: "invalid_api_key",
    type: "authentication_error"
  })
}

function secureCookies(event: H3Event): boolean {
  if (process.env.NEURALWATT_SECURE_COOKIES === "1") return true
  return getRequestProtocol(event) === "https"
}

export function assertSameOrigin(event: H3Event): void {
  const origin = getHeader(event, "origin")
  if (!origin) return
  const trustProxy = process.env.NEURALWATT_TRUST_PROXY === "1"
  const protocol = trustProxy
    ? getHeader(event, "x-forwarded-proto")?.split(",", 1)[0]?.trim() || getRequestProtocol(event)
    : getRequestProtocol(event)
  const host = trustProxy
    ? getHeader(event, "x-forwarded-host")?.split(",", 1)[0]?.trim() || getRequestHost(event)
    : getRequestHost(event)
  if (origin === `${protocol}://${host}`) return
  throw new ApiError("Cross-origin administrator mutations are not allowed", {
    status: 403,
    code: "origin_not_allowed"
  })
}
