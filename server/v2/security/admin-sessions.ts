import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { ApiError } from "../shared/errors"
import { ADMIN_SESSION_TTL_MS } from "../shared/limits"

export const ADMIN_SESSION_COOKIE = "nw_v2_admin"
export const ADMIN_CSRF_HEADER = "x-csrf-token"

export interface AdminSession {
  token: string
  csrfToken: string
  createdAt: number
  expiresAt: number
}

export interface AdminSessionManagerOptions {
  now?: () => number
  ttlMs?: number
  createToken?: (purpose: "session" | "csrf") => string
  maximumSessions?: number
}

interface StoredSession {
  csrfToken: string
  csrfDigest: Buffer
  createdAt: number
  expiresAt: number
}

export interface AdminCookieOptions {
  httpOnly: true
  secure: boolean
  sameSite: "strict"
  path: "/"
  maxAge: number
  expires: Date
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

function tokenKey(value: string): string {
  return tokenDigest(value).toString("hex")
}

function defaultToken(): string {
  return randomBytes(32).toString("base64url")
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,512}$/.test(value)
}

export function adminSessionCookieOptions(
  expiresAt: number,
  options: { now?: number; secure?: boolean } = {}
): AdminCookieOptions {
  const now = options.now ?? Date.now()
  return {
    httpOnly: true,
    secure: options.secure ?? true,
    sameSite: "strict",
    path: "/",
    maxAge: Math.max(0, Math.ceil((expiresAt - now) / 1_000)),
    expires: new Date(expiresAt)
  }
}

export function clearAdminSessionCookieOptions(options: { secure?: boolean } = {}): AdminCookieOptions {
  return {
    httpOnly: true,
    secure: options.secure ?? true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
    expires: new Date(0)
  }
}

export class AdminSessionManager {
  readonly #sessions = new Map<string, StoredSession>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #createToken: (purpose: "session" | "csrf") => string
  readonly #maximumSessions: number

  constructor(options: AdminSessionManagerOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? ADMIN_SESSION_TTL_MS
    this.#createToken = options.createToken ?? defaultToken
    this.#maximumSessions = options.maximumSessions ?? 256
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1_000 || this.#ttlMs > ADMIN_SESSION_TTL_MS) {
      throw new TypeError(`ttlMs must be between 1000 and ${ADMIN_SESSION_TTL_MS}`)
    }
    if (!Number.isSafeInteger(this.#maximumSessions) || this.#maximumSessions < 1 || this.#maximumSessions > 10_000) {
      throw new TypeError("maximumSessions must be between 1 and 10000")
    }
  }

  create(): AdminSession {
    this.prune()
    const token = this.#createToken("session")
    const csrfToken = this.#createToken("csrf")
    if (!validToken(token) || !validToken(csrfToken) || token === csrfToken) {
      throw new ApiError("The administrator session token generator returned an invalid value", {
        status: 500,
        code: "admin_session_generation_failed"
      })
    }
    const key = tokenKey(token)
    if (this.#sessions.has(key)) {
      throw new ApiError("The administrator session token generator produced a collision", {
        status: 500,
        code: "admin_session_collision"
      })
    }
    while (this.#sessions.size >= this.#maximumSessions) {
      const oldest = this.#sessions.keys().next().value as string | undefined
      if (!oldest) break
      this.#sessions.delete(oldest)
    }
    const createdAt = this.#now()
    const expiresAt = createdAt + this.#ttlMs
    this.#sessions.set(key, { csrfToken, csrfDigest: tokenDigest(csrfToken), createdAt, expiresAt })
    return { token, csrfToken, createdAt, expiresAt }
  }

  verify(token: unknown): boolean {
    return this.lookup(token) !== undefined
  }

  describe(token: unknown): AdminSession | undefined {
    if (!validToken(token)) return undefined
    const session = this.lookup(token)
    if (!session) return undefined
    return {
      token,
      csrfToken: session.csrfToken,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    }
  }

  assertAuthenticated(token: unknown): void {
    if (this.verify(token)) return
    throw new ApiError("A valid administrator session is required", {
      status: 401,
      code: "admin_session_required"
    })
  }

  verifyCsrf(token: unknown, csrfToken: unknown): boolean {
    const session = this.lookup(token)
    if (!session || !validToken(csrfToken)) return false
    const provided = tokenDigest(csrfToken)
    return provided.length === session.csrfDigest.length && timingSafeEqual(provided, session.csrfDigest)
  }

  assertCsrf(token: unknown, csrfToken: unknown): void {
    this.assertAuthenticated(token)
    if (this.verifyCsrf(token, csrfToken)) return
    throw new ApiError("A valid CSRF token is required", {
      status: 403,
      code: "csrf_token_invalid"
    })
  }

  logout(token: unknown): boolean {
    if (!validToken(token)) return false
    return this.#sessions.delete(tokenKey(token))
  }

  revokeAll(): number {
    const count = this.#sessions.size
    this.#sessions.clear()
    return count
  }

  get activeCount(): number {
    this.prune()
    return this.#sessions.size
  }

  private lookup(token: unknown): StoredSession | undefined {
    if (!validToken(token)) return undefined
    const key = tokenKey(token)
    const session = this.#sessions.get(key)
    if (!session) return undefined
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(key)
      return undefined
    }
    return session
  }

  private prune(): void {
    const now = this.#now()
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(key)
    }
  }
}
