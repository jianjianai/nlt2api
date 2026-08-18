import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ApiError } from "../../server/v2/shared/errors"
import { V2StateRepository } from "../../server/v2/state"
import {
  AdminSecurityService,
  AdminSessionManager,
  InferenceApiKeyService,
  LoginFailureLimiter,
  PasswordHasher,
  adminSessionCookieOptions,
  clearAdminSessionCookieOptions
} from "../../server/v2/security"

async function temporaryRepository(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "neuralwatt-v2-security-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "state.yaml")
  return { file, repository: await V2StateRepository.open(file) }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ApiError && error.code === code
}

function fastPasswordHasher(): PasswordHasher {
  return new PasswordHasher({
    randomSalt: () => Buffer.alloc(16, 7),
    derive: async (password, salt) => createHash("sha512").update(salt).update(password, "utf8").digest()
  })
}

function tokenFactory(): (purpose: "session" | "csrf") => string {
  let sequence = 0
  return (purpose) => `${purpose}-${String(++sequence).padStart(4, "0")}-${"x".repeat(32)}`
}

test("inference API keys are hashed, revealed once, cloned, and enabled-only", async (t) => {
  const { file, repository } = await temporaryRepository(t)
  const secret = `nw-v2-${"a".repeat(43)}`
  const keys = new InferenceApiKeyService(repository, {
    now: () => Date.parse("2026-08-18T02:00:00.000Z"),
    createId: () => "api_key_0001",
    createSecret: () => secret
  })
  const created = await keys.create("Primary client")
  assert.equal(created.secret, secret)
  assert.equal(created.apiKey.preview.includes("..."), true)
  assert.equal("secret" in created.apiKey, false)
  assert.equal("digest" in created.apiKey, false)

  const state = await repository.snapshot()
  assert.equal(state.inferenceApiKeys[0].digest, createHash("sha256").update(secret).digest("hex"))
  assert.equal(JSON.stringify(state).includes(secret), false)
  assert.deepEqual(Object.keys(state.inferenceApiKeys[0]).sort(), [
    "createdAt", "digest", "enabled", "id", "label", "preview", "updatedAt"
  ])

  const listed = await keys.list()
  listed[0].label = "mutated"
  assert.equal((await keys.list())[0].label, "Primary client")
  assert.equal(await keys.verify(secret), true)
  assert.equal(await keys.verify(`${secret}x`), false)

  await keys.toggle(created.apiKey.id)
  assert.equal(await keys.verify(secret), false)
  await keys.toggle(created.apiKey.id, true)
  assert.equal(await keys.verify(secret), true)
  assert.equal((await keys.rename(created.apiKey.id, "Renamed")).label, "Renamed")

  const restarted = new InferenceApiKeyService(await V2StateRepository.open(file))
  assert.equal(await restarted.verify(secret), true)
  await restarted.delete(created.apiKey.id)
  assert.equal(await restarted.verify(secret), false)
  assert.deepEqual(await restarted.list(), [])
})

test("password hashes use fixed scrypt parameters and reject malformed formats before KDF", async () => {
  const hasher = new PasswordHasher({ randomSalt: () => Buffer.alloc(16, 3) })
  const hash = await hasher.hash("correct horse battery staple")
  assert.match(hash, /^scrypt\$16384\$8\$1\$/)
  assert.equal(await hasher.verify("correct horse battery staple", hash), true)
  assert.equal(await hasher.verify("wrong password", hash), false)

  let deriveCalls = 0
  const guarded = new PasswordHasher({
    derive: async () => {
      deriveCalls += 1
      return Buffer.alloc(64)
    }
  })
  await assert.rejects(
    () => guarded.verify("password", "scrypt$999999999$8$1$bad$bad"),
    hasCode("admin_password_hash_invalid")
  )
  assert.equal(deriveCalls, 0)
  await assert.rejects(() => hasher.hash("short"), hasCode("invalid_admin_password"))
})

test("administrator sessions enforce expiry, CSRF, logout, revoke-all, and secure cookies", () => {
  let now = 10_000
  const sessions = new AdminSessionManager({ now: () => now, ttlMs: 2_000, createToken: tokenFactory() })
  const first = sessions.create()
  assert.equal(sessions.verify(first.token), true)
  assert.equal(sessions.verifyCsrf(first.token, first.csrfToken), true)
  assert.equal(sessions.verifyCsrf(first.token, `${first.csrfToken}x`), false)
  assert.throws(() => sessions.assertCsrf(first.token, "wrong-token-that-is-long-enough-xxxxxxxx"), hasCode("csrf_token_invalid"))

  assert.equal(sessions.logout(first.token), true)
  assert.equal(sessions.verify(first.token), false)
  const second = sessions.create()
  const third = sessions.create()
  assert.equal(sessions.revokeAll(), 2)
  assert.equal(sessions.verify(second.token), false)
  assert.equal(sessions.verify(third.token), false)

  const expiring = sessions.create()
  now = expiring.expiresAt
  assert.equal(sessions.verify(expiring.token), false)
  assert.equal(sessions.activeCount, 0)

  const cookie = adminSessionCookieOptions(20_000, { now: 10_000 })
  assert.deepEqual(cookie, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 10,
    expires: new Date(20_000)
  })
  assert.equal(clearAdminSessionCookieOptions().maxAge, 0)
  assert.equal(clearAdminSessionCookieOptions().secure, true)

  const defaults = new AdminSessionManager({ now: () => 0, createToken: tokenFactory() })
  const defaultSession = defaults.create()
  assert.equal(defaultSession.expiresAt - defaultSession.createdAt, 12 * 60 * 60 * 1_000)

  const bounded = new AdminSessionManager({ now: () => 0, createToken: tokenFactory(), maximumSessions: 2 })
  const oldest = bounded.create()
  bounded.create()
  bounded.create()
  assert.equal(bounded.activeCount, 2)
  assert.equal(bounded.verify(oldest.token), false)
})

test("login limiter is bounded and resets after a completed block", () => {
  let now = 1_000
  const limiter = new LoginFailureLimiter({
    now: () => now,
    maximumFailures: 2,
    windowMs: 10_000,
    blockMs: 2_000,
    maximumEntries: 2
  })
  assert.deepEqual(limiter.recordFailure("client-a"), { blocked: false })
  assert.deepEqual(limiter.recordFailure("client-a"), { blocked: true, retryAfterSeconds: 2 })
  assert.throws(() => limiter.assertAllowed("client-a"), (error: unknown) => {
    return error instanceof ApiError && error.code === "admin_login_rate_limited" && error.retryAfterSeconds === 2
  })
  now += 2_000
  limiter.assertAllowed("client-a")
  assert.deepEqual(limiter.recordFailure("client-a"), { blocked: false })

  limiter.recordFailure("client-b")
  limiter.recordFailure("client-c")
  assert.equal(limiter.size, 2)
  limiter.recordSuccess("client-c")
  assert.equal(limiter.size, 1)
})

test("admin security separates inference keys, rate limits failures, and rotates sessions on password change", async (t) => {
  let now = 100_000
  const { repository } = await temporaryRepository(t)
  const sessions = new AdminSessionManager({ now: () => now, ttlMs: 10_000, createToken: tokenFactory() })
  const limiter = new LoginFailureLimiter({
    now: () => now,
    maximumFailures: 2,
    windowMs: 10_000,
    blockMs: 2_000,
    maximumEntries: 10
  })
  const admin = new AdminSecurityService(repository, {
    passwordHasher: fastPasswordHasher(),
    sessions,
    loginLimiter: limiter,
    canInitializePassword: () => true
  })
  assert.equal(await admin.hasPassword(), false)
  const initialized = await admin.initializePassword("initial-password")
  assert.equal(admin.sessions.verify(initialized.token), true)
  assert.equal(await admin.hasPassword(), true)
  await assert.rejects(() => admin.initializePassword("another-password"), hasCode("admin_password_already_configured"))

  const inferenceSecret = `nw-v2-${"z".repeat(43)}`
  const inferenceKeys = new InferenceApiKeyService(repository, {
    createId: () => "api_key_admin_test",
    createSecret: () => inferenceSecret,
    now: () => now
  })
  await inferenceKeys.create("Inference only")
  await assert.rejects(() => admin.login(inferenceSecret, "client-inference"), hasCode("invalid_admin_password"))

  await assert.rejects(() => admin.login("wrong-password", "client-a"), hasCode("invalid_admin_password"))
  await assert.rejects(() => admin.login("wrong-password", "client-a"), hasCode("invalid_admin_password"))
  await assert.rejects(() => admin.login("initial-password", "client-a"), hasCode("admin_login_rate_limited"))
  now += 2_000
  const loggedIn = await admin.login("initial-password", "client-a")
  assert.equal(admin.sessions.verify(loggedIn.token), true)

  const changed = await admin.changePassword({
    sessionToken: loggedIn.token,
    csrfToken: loggedIn.csrfToken,
    currentPassword: "initial-password",
    newPassword: "replacement-password",
    limiterIdentifier: "client-a"
  })
  assert.equal(admin.sessions.verify(initialized.token), false)
  assert.equal(admin.sessions.verify(loggedIn.token), false)
  assert.equal(admin.sessions.verify(changed.token), true)
  await assert.rejects(() => admin.login("initial-password", "old-password-client"), hasCode("invalid_admin_password"))
  assert.equal(admin.sessions.verify((await admin.login("replacement-password", "new-password-client")).token), true)

  admin.logout(changed.token, changed.csrfToken)
  assert.equal(admin.sessions.verify(changed.token), false)
})
