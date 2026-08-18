import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto"
import { promisify } from "node:util"
import { ApiError, invalidRequest } from "../shared/errors"

const scrypt = promisify(scryptCallback) as unknown as (
  password: string | NodeJS.ArrayBufferView,
  salt: string | NodeJS.ArrayBufferView,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>

export const ADMIN_PASSWORD_MIN_LENGTH = 8
export const ADMIN_PASSWORD_MAX_LENGTH = 1_024
export const SCRYPT_N = 16_384
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const SCRYPT_SALT_BYTES = 16
export const SCRYPT_KEY_BYTES = 64
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024

export type PasswordDeriver = (password: string, salt: Uint8Array) => Promise<Buffer>

export interface PasswordHasherOptions {
  randomSalt?: () => Uint8Array
  derive?: PasswordDeriver
}

interface ParsedPasswordHash {
  salt: Buffer
  expected: Buffer
}

async function defaultDerive(password: string, salt: Uint8Array): Promise<Buffer> {
  return await scrypt(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY
  }) as Buffer
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const decoded = Buffer.from(value, "base64url")
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) return undefined
  return decoded
}

export function parseAdminPasswordHash(stored: unknown): ParsedPasswordHash {
  if (typeof stored !== "string" || stored.length > 512) {
    throw new ApiError("The stored administrator password hash is invalid", {
      status: 500,
      code: "admin_password_hash_invalid"
    })
  }
  const parts = stored.split("$")
  if (parts.length !== 6
    || parts[0] !== "scrypt"
    || parts[1] !== String(SCRYPT_N)
    || parts[2] !== String(SCRYPT_R)
    || parts[3] !== String(SCRYPT_P)) {
    throw new ApiError("The stored administrator password hash uses an unsupported format", {
      status: 500,
      code: "admin_password_hash_invalid"
    })
  }
  const salt = decodeCanonicalBase64Url(parts[4], SCRYPT_SALT_BYTES)
  const expected = decodeCanonicalBase64Url(parts[5], SCRYPT_KEY_BYTES)
  if (!salt || !expected) {
    throw new ApiError("The stored administrator password hash is malformed", {
      status: 500,
      code: "admin_password_hash_invalid"
    })
  }
  return { salt, expected }
}

function passwordForHash(value: unknown): string {
  if (typeof value !== "string" || value.length < ADMIN_PASSWORD_MIN_LENGTH || value.length > ADMIN_PASSWORD_MAX_LENGTH) {
    throw invalidRequest(
      `password must contain between ${ADMIN_PASSWORD_MIN_LENGTH} and ${ADMIN_PASSWORD_MAX_LENGTH} characters`,
      "invalid_admin_password",
      "password"
    )
  }
  return value
}

function passwordForVerification(value: unknown): string {
  if (typeof value !== "string" || value.length > ADMIN_PASSWORD_MAX_LENGTH) {
    throw invalidRequest(
      `password must be no longer than ${ADMIN_PASSWORD_MAX_LENGTH} characters`,
      "invalid_admin_password",
      "password"
    )
  }
  return value
}

export class PasswordHasher {
  readonly #randomSalt: () => Uint8Array
  readonly #derive: PasswordDeriver

  constructor(options: PasswordHasherOptions = {}) {
    this.#randomSalt = options.randomSalt ?? (() => randomBytes(SCRYPT_SALT_BYTES))
    this.#derive = options.derive ?? defaultDerive
  }

  async hash(passwordInput: unknown): Promise<string> {
    const password = passwordForHash(passwordInput)
    const salt = Buffer.from(this.#randomSalt())
    if (salt.length !== SCRYPT_SALT_BYTES) {
      throw new ApiError("The password salt generator returned an invalid value", {
        status: 500,
        code: "admin_password_hash_failed"
      })
    }
    const derived = await this.#derive(password, salt)
    if (derived.length !== SCRYPT_KEY_BYTES) {
      throw new ApiError("The password derivation function returned an invalid value", {
        status: 500,
        code: "admin_password_hash_failed"
      })
    }
    return [
      "scrypt",
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      salt.toString("base64url"),
      derived.toString("base64url")
    ].join("$")
  }

  async verify(passwordInput: unknown, stored: unknown): Promise<boolean> {
    // Parse and bound all persisted parameters before invoking the expensive KDF.
    const parsed = parseAdminPasswordHash(stored)
    const password = passwordForVerification(passwordInput)
    const derived = await this.#derive(password, parsed.salt)
    return derived.length === parsed.expected.length && timingSafeEqual(derived, parsed.expected)
  }
}
