import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { deleteCookie, getCookie, getHeader, setCookie, type H3Event } from "h3"
import { AppError } from "./errors"
import { getAdminPasswordHash, getAdminSessionSecret, getProxyKey } from "./store"

const scrypt = promisify(scryptCallback)

const KEY_LENGTH = 64
export const ADMIN_SESSION_COOKIE = "nw_admin"
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

// scrypt parameters ride along with the hash so they can be raised later.
export async function hashAdminPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 })) as Buffer
  return ["scrypt", 16384, 8, 1, salt.toString("base64url"), derived.toString("base64url")].join("$")
}

async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const [, n, r, p, salt, expected] = parts
  const derived = (await scrypt(password, Buffer.from(salt, "base64url"), KEY_LENGTH, {
    N: Number(n),
    r: Number(r),
    p: Number(p)
  })) as Buffer
  const expectedBuffer = Buffer.from(expected, "base64url")
  return derived.length === expectedBuffer.length && timingSafeEqual(derived, expectedBuffer)
}

export type AdminPasswordCheck = "ok" | "wrong" | "unset"

// NEURALWATT_ADMIN_PASSWORD overrides the stored hash so a forgotten password can be recovered.
export async function checkAdminPassword(password: string): Promise<AdminPasswordCheck> {
  const envPassword = process.env.NEURALWATT_ADMIN_PASSWORD
  if (envPassword) {
    const provided = Buffer.from(password)
    const expected = Buffer.from(envPassword)
    const ok = provided.length === expected.length && timingSafeEqual(provided, expected)
    return ok ? "ok" : "wrong"
  }

  const hash = await getAdminPasswordHash()
  if (!hash) return "unset"
  return (await verifyPasswordHash(password, hash)) ? "ok" : "wrong"
}

export async function hasAdminPassword(): Promise<boolean> {
  return Boolean(process.env.NEURALWATT_ADMIN_PASSWORD || (await getAdminPasswordHash()))
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

export function createSessionToken(secret: string, ttlMs = SESSION_TTL_MS): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + ttlMs
  const payload = `${expiresAt}.${randomBytes(16).toString("base64url")}`
  return { token: `${payload}.${signPayload(payload, secret)}`, expiresAt }
}

export function verifySessionToken(token: string | undefined, secret: string): boolean {
  if (!token) return false
  const [expiresAtText, nonce, signature] = token.split(".")
  if (!expiresAtText || !nonce || !signature) return false
  const expiresAt = Number(expiresAtText)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
  const provided = Buffer.from(signature)
  const expected = Buffer.from(signPayload(`${expiresAtText}.${nonce}`, secret))
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

export function setAdminSessionCookie(event: H3Event, token: string, expiresAt: number): void {
  setCookie(event, ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt)
  })
}

export function clearAdminSessionCookie(event: H3Event): void {
  deleteCookie(event, ADMIN_SESSION_COOKIE, { path: "/" })
}

// Management API guard: admin session cookie first, local proxy Bearer key as script fallback.
export async function requireAdminAuth(event: H3Event): Promise<void> {
  const token = getCookie(event, ADMIN_SESSION_COOKIE)
  if (token && verifySessionToken(token, await getAdminSessionSecret())) {
    return
  }

  const header = getHeader(event, "authorization")
  const match = header?.match(/^Bearer\s+(.+)$/i)
  const provided = match?.[1] ?? ""
  const expected = await getProxyKey()
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length > 0 && providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)) {
    return
  }

  throw new AppError("Admin authentication required", 401, "admin_auth_required")
}
