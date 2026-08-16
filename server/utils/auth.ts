import { timingSafeEqual } from "node:crypto"
import { getHeader, type H3Event } from "h3"
import { AppError } from "./errors"
import { getProxyKey } from "./store"

export async function requireProxyAuth(event: H3Event): Promise<void> {
  const header = getHeader(event, "authorization")
  const match = header?.match(/^Bearer\s+(.+)$/i)
  const provided = match?.[1] ?? ""
  const expected = await getProxyKey()
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  const valid = providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)

  if (!valid) {
    throw new AppError("A valid local proxy API key is required", 401, "invalid_proxy_key", undefined, "authentication_error")
  }
}
