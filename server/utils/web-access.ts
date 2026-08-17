import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { resolve } from "node:path"
import { deleteCookie, getCookie, getRequestProtocol, setCookie, type H3Event } from "h3"
import { AppError } from "./errors"

const WEB_ACCESS_COOKIE = "neuralwatt-web-access"
const SESSION_TTL_SECONDS = 12 * 60 * 60
const sessionSecret = randomBytes(32)
let localEnvironmentLoaded = false

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function getWebAccessKey(): string {
  if (!localEnvironmentLoaded && !process.env.NEURALWATT_WEB_ACCESS_KEY) {
    localEnvironmentLoaded = true
    try {
      process.loadEnvFile(resolve(process.cwd(), ".env.local"))
    } catch {
      throw new AppError("The local web access configuration could not be read", 500, "web_access_config_read_failed")
    }
  }

  const accessKey = process.env.NEURALWATT_WEB_ACCESS_KEY?.trim()
  if (!accessKey) {
    throw new AppError("The web access key is not configured", 503, "web_access_not_configured")
  }
  return accessKey
}

function sign(value: string): string {
  return createHmac("sha256", sessionSecret).update(value).digest("base64url")
}

function cookieOptions(event: H3Event) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: getRequestProtocol(event) === "https",
    maxAge: SESSION_TTL_SECONDS
  }
}

export function createWebAccessSession(now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS
  const nonce = randomBytes(16).toString("base64url")
  const payload = `v1.${expiresAt}.${nonce}`
  return `${payload}.${sign(payload)}`
}

export function isWebAccessSessionValid(session: string | undefined, now = Date.now()): boolean {
  if (!session) return false
  const [version, expiresAtText, nonce, signature, ...rest] = session.split(".")
  if (version !== "v1" || !expiresAtText || !nonce || !signature || rest.length > 0) return false

  const expiresAt = Number(expiresAtText)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false
  const payload = `${version}.${expiresAtText}.${nonce}`
  return secureEqual(signature, sign(payload))
}

export function hasWebAccessSession(event: H3Event): boolean {
  return isWebAccessSessionValid(getCookie(event, WEB_ACCESS_COOKIE))
}

export function unlockWebAccess(event: H3Event, submittedKey: string): boolean {
  if (!secureEqual(submittedKey, getWebAccessKey())) return false

  setCookie(event, WEB_ACCESS_COOKIE, createWebAccessSession(), cookieOptions(event))
  return true
}

export function clearWebAccess(event: H3Event): void {
  deleteCookie(event, WEB_ACCESS_COOKIE, cookieOptions(event))
}
