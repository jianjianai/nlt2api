import { timingSafeEqual } from "node:crypto"
import { getCookie, getHeader, type H3Event } from "h3"
import { ADMIN_SESSION_COOKIE, verifySessionToken } from "./admin-auth"
import { AppError } from "./errors"
import { getAdminSessionSecret, getProxyKey } from "./store"

export async function requireProxyAuth(event: H3Event): Promise<void> {
  const header = getHeader(event, "authorization")
  const match = header?.match(/^Bearer\s+(.+)$/i)
  const provided = match?.[1] ?? ""
  const expected = await getProxyKey()
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)) return

  // The admin UI test panel calls the proxy API with its session cookie instead of the key.
  const token = getCookie(event, ADMIN_SESSION_COOKIE)
  if (token && verifySessionToken(token, await getAdminSessionSecret())) return

  throw new AppError("A valid local proxy API key is required", 401, "invalid_proxy_key", undefined, "authentication_error")
}
