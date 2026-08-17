import { timingSafeEqual } from "node:crypto"
import { getCookie, getHeader, type H3Event } from "h3"
import { ADMIN_SESSION_COOKIE, verifySessionToken } from "./admin-auth"
import { AppError } from "./errors"
import { getAdminSessionSecret, listProxyKeys } from "./store"
import { hasWebAccessSession } from "./web-access"

async function hasValidAdminSession(event: H3Event): Promise<boolean> {
  const token = getCookie(event, ADMIN_SESSION_COOKIE)
  return Boolean(token && verifySessionToken(token, await getAdminSessionSecret()))
}

async function hasValidProxyBearer(event: H3Event): Promise<boolean> {
  const header = getHeader(event, "authorization")
  const match = header?.match(/^Bearer\s+(.+)$/i)
  const provided = match?.[1] ?? ""
  if (!provided) return false

  const providedBuffer = Buffer.from(provided)
  let valid = false
  for (const key of await listProxyKeys()) {
    const expectedBuffer = Buffer.from(key.value)
    const matches = providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)
    valid = (key.enabled && matches) || valid
  }
  return valid
}

export async function requireProxyAuth(event: H3Event): Promise<void> {
  if (!await hasValidProxyBearer(event)) {
    throw new AppError("A valid local proxy API key is required", 401, "invalid_proxy_key", undefined, "authentication_error")
  }
}

export async function requireManagementAuth(event: H3Event): Promise<void> {
  if (hasWebAccessSession(event) || await hasValidAdminSession(event) || await hasValidProxyBearer(event)) return
  throw new AppError("A valid management session or local proxy API key is required", 401, "invalid_management_auth", undefined, "authentication_error")
}

export function requireWebAccessSession(event: H3Event): void {
  if (hasWebAccessSession(event)) return
  throw new AppError("A valid web access session is required", 401, "invalid_web_access", undefined, "authentication_error")
}
