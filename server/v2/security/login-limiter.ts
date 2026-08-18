import { createHash } from "node:crypto"
import { ApiError, invalidRequest } from "../shared/errors"

export interface LoginFailureLimiterOptions {
  now?: () => number
  maximumFailures?: number
  windowMs?: number
  blockMs?: number
  maximumEntries?: number
}

interface FailureEntry {
  failures: number
  windowStartedAt: number
  blockedUntil: number
  lastSeenAt: number
}

const DEFAULT_MAXIMUM_FAILURES = 5
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000
const DEFAULT_BLOCK_MS = 15 * 60 * 1_000
const DEFAULT_MAXIMUM_ENTRIES = 10_000

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function identifierKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw invalidRequest("login limiter identifier is invalid", "invalid_login_identifier")
  }
  return createHash("sha256").update(value.trim(), "utf8").digest("hex")
}

export class LoginFailureLimiter {
  readonly #entries = new Map<string, FailureEntry>()
  readonly #now: () => number
  readonly #maximumFailures: number
  readonly #windowMs: number
  readonly #blockMs: number
  readonly #maximumEntries: number

  constructor(options: LoginFailureLimiterOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#maximumFailures = boundedInteger(options.maximumFailures ?? DEFAULT_MAXIMUM_FAILURES, "maximumFailures", 1, 100)
    this.#windowMs = boundedInteger(options.windowMs ?? DEFAULT_WINDOW_MS, "windowMs", 1_000, 24 * 60 * 60 * 1_000)
    this.#blockMs = boundedInteger(options.blockMs ?? DEFAULT_BLOCK_MS, "blockMs", 1_000, 24 * 60 * 60 * 1_000)
    this.#maximumEntries = boundedInteger(options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES, "maximumEntries", 1, 100_000)
  }

  assertAllowed(identifier: unknown): void {
    const key = identifierKey(identifier)
    const now = this.#now()
    const entry = this.#entries.get(key)
    if (!entry) return
    if (entry.blockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1_000))
      throw new ApiError("Too many administrator login failures", {
        status: 429,
        code: "admin_login_rate_limited",
        retryAfterSeconds
      })
    }
    if (entry.blockedUntil > 0) {
      this.#entries.delete(key)
      return
    }
    if (now - entry.windowStartedAt >= this.#windowMs) this.#entries.delete(key)
  }

  recordFailure(identifier: unknown): { blocked: boolean; retryAfterSeconds?: number } {
    const key = identifierKey(identifier)
    const now = this.#now()
    this.prune(now)
    let entry = this.#entries.get(key)
    if (!entry || now - entry.windowStartedAt >= this.#windowMs) {
      this.ensureCapacity()
      entry = { failures: 0, windowStartedAt: now, blockedUntil: 0, lastSeenAt: now }
      this.#entries.set(key, entry)
    }
    entry.failures += 1
    entry.lastSeenAt = now
    if (entry.failures >= this.#maximumFailures) {
      entry.blockedUntil = now + this.#blockMs
      return { blocked: true, retryAfterSeconds: Math.ceil(this.#blockMs / 1_000) }
    }
    return { blocked: false }
  }

  recordSuccess(identifier: unknown): void {
    this.#entries.delete(identifierKey(identifier))
  }

  get size(): number {
    this.prune(this.#now())
    return this.#entries.size
  }

  private prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.blockedUntil > now) continue
      if (now - entry.windowStartedAt >= this.#windowMs) this.#entries.delete(key)
    }
  }

  private ensureCapacity(): void {
    if (this.#entries.size < this.#maximumEntries) return
    let oldestKey: string | undefined
    let oldestSeen = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.#entries) {
      if (entry.lastSeenAt < oldestSeen) {
        oldestSeen = entry.lastSeenAt
        oldestKey = key
      }
    }
    if (oldestKey) this.#entries.delete(oldestKey)
  }
}
