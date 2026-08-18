import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ApiError } from "../../server/v2/shared/errors"
import {
  AccountService,
  SettingsService,
  V2StateRepository,
  createEmptyV2State,
  parseV2State
} from "../../server/v2/state"

async function temporaryState(t: { after(callback: () => Promise<void>): void }, options: Parameters<typeof V2StateRepository.open>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "neuralwatt-v2-state-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "state.yaml")
  const repository = await V2StateRepository.open(file, options)
  return { directory, file, repository }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ApiError && error.code === code
}

test("v2 schema rejects old versions and unknown properties without normalization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "neuralwatt-v2-schema-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "state.yaml")
  await writeFile(file, "version: 1\n", "utf8")
  await assert.rejects(() => V2StateRepository.open(file), hasCode("state_version_unsupported"))

  const invalid = { ...createEmptyV2State(), legacy: true }
  assert.throws(() => parseV2State(invalid), hasCode("state_schema_invalid"))
})

test("repository publishes deep clones and survives restart with restrictive mode", async (t) => {
  const { file, repository } = await temporaryState(t)
  const first = await repository.snapshot()
  first.generationDefaults.maxTokens = 99
  assert.equal((await repository.snapshot()).generationDefaults.maxTokens, 4_096)

  const result = await repository.transact((draft) => {
    draft.generationDefaults.maxTokens = 5_000
    return draft.generationDefaults
  })
  result.maxTokens = 12
  assert.equal((await repository.snapshot()).generationDefaults.maxTokens, 5_000)
  assert.equal((await (await V2StateRepository.open(file)).snapshot()).generationDefaults.maxTokens, 5_000)

  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
})

test("repository readiness validates directory writes without changing state", async (t) => {
  const { directory, file, repository } = await temporaryState(t)
  const before = await readFile(file, "utf8")
  await repository.assertReady()
  assert.equal(await readFile(file, "utf8"), before)
  assert.deepEqual(await readdir(directory), ["state.yaml"])
})

test("repository serializes concurrent copy-on-write transactions", async (t) => {
  const { repository } = await temporaryState(t)
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => repository.transact(async (draft) => {
    if (index % 2 === 0) await Promise.resolve()
    draft.generationDefaults.maxTokens += 1
    return draft.generationDefaults.maxTokens
  })))
  assert.equal(new Set(results).size, 40)
  assert.equal((await repository.snapshot()).generationDefaults.maxTokens, 4_136)
})

test("failed persistence leaves memory and disk snapshots unchanged and queue usable", async (t) => {
  let failNext = false
  const { file, repository } = await temporaryState(t, {
    beforePromote: () => {
      if (!failNext) return
      failNext = false
      throw new Error("injected persistence failure")
    }
  })
  failNext = true
  await assert.rejects(() => repository.transact((draft) => {
    draft.generationDefaults.maxTokens = 8_000
  }), hasCode("state_write_failed"))
  assert.equal((await repository.snapshot()).generationDefaults.maxTokens, 4_096)
  assert.equal((await (await V2StateRepository.open(file)).snapshot()).generationDefaults.maxTokens, 4_096)

  await repository.transact((draft) => {
    draft.generationDefaults.maxTokens = 6_000
  })
  assert.equal((await repository.snapshot()).generationDefaults.maxTokens, 6_000)
})

test("repository recovers the last committed backup after an interrupted promotion", async (t) => {
  const { file, repository } = await temporaryState(t)
  await repository.transact((draft) => {
    draft.generationDefaults.maxTokens = 5_500
  })
  const backup = `${file}.bak`
  await unlink(backup)
  await rename(file, backup)
  const recovered = await V2StateRepository.open(file)
  assert.equal((await recovered.snapshot()).generationDefaults.maxTokens, 5_500)
  assert.match(await readFile(file, "utf8"), /version:\s*2/)
})

test("account service validates input, hides secrets, and invalidates sessions on credential changes", async (t) => {
  let now = Date.parse("2026-08-18T00:00:00.000Z")
  let id = 0
  const { repository } = await temporaryState(t)
  const accounts = new AccountService(repository, {
    now: () => now,
    createId: () => `account_${String(++id).padStart(4, "0")}`
  })

  await assert.rejects(() => accounts.createAccount({ label: "bad", email: "not-an-email", password: "password" }), hasCode("invalid_account"))
  const created = await accounts.createAccount({
    label: "Primary",
    email: "owner@example.com",
    password: "portal-secret",
    cookie: "session=one"
  })
  assert.equal("password" in created, false)
  assert.equal("cookie" in created, false)
  assert.equal(created.hasPassword, true)
  assert.equal(created.hasCookie, true)

  const internal = await accounts.getAccountRecord(created.id)
  internal.password = "mutated-copy"
  assert.equal((await accounts.getAccountRecord(created.id)).password, "portal-secret")
  assert.equal((await accounts.listEnabledAccounts()).length, 1)

  now += 1_000
  const changedEmail = await accounts.updateAccount(created.id, { email: "new@example.com" }, { expectedRevision: 1 })
  assert.equal(changedEmail.hasCookie, false)
  assert.equal(changedEmail.status, "unknown")
  assert.equal((await accounts.getAccountRecord(created.id)).cookie, "")

  now += 1_000
  const replacement = await accounts.updateAccount(created.id, {
    password: "new-portal-secret",
    cookie: "session=replacement"
  }, { expectedRevision: 2 })
  assert.equal(replacement.hasCookie, true)
  assert.equal(replacement.status, "unknown")

  await assert.rejects(() => accounts.updateAccountRuntime(created.id, {
    status: "ready",
    cookie: "session=stale",
    markLogin: true
  }, { expectedRevision: 1 }), hasCode("account_revision_conflict"))
  assert.equal((await accounts.getAccountRecord(created.id)).cookie, "session=replacement")

  now += 1_000
  const ready = await accounts.updateAccountRuntime(created.id, {
    status: "ready",
    cookie: "session=fresh",
    markLogin: true
  }, { expectedRevision: replacement.revision })
  assert.equal(ready.status, "ready")
  assert.equal(ready.lastLoginAt, "2026-08-18T00:00:03.000Z")

  await assert.rejects(() => accounts.createAccount({
    label: "Duplicate",
    email: "NEW@example.com",
    password: "another-secret"
  }), hasCode("account_email_exists"))
  await assert.rejects(() => accounts.updateAccount(created.id, { cookie: "bad\r\ncookie" }), hasCode("invalid_account"))

  await accounts.deleteAccount(created.id, { expectedRevision: ready.revision })
  assert.deepEqual(await accounts.listAccounts(), [])
})

test("settings service clones catalogs and validates generation defaults", async (t) => {
  const { repository } = await temporaryState(t)
  const settings = new SettingsService(repository, { now: () => Date.parse("2026-08-18T01:02:03.000Z") })
  await assert.rejects(() => settings.setGenerationDefaults({ temperature: 3, maxTokens: 1, topP: 1 }), hasCode("invalid_generation_defaults"))
  assert.deepEqual(await settings.setGenerationDefaults({ temperature: 0.2, maxTokens: 8_192, topP: 0.9 }), {
    temperature: 0.2,
    maxTokens: 8_192,
    topP: 0.9
  })
  const catalog = await settings.replaceModelCatalog({ data: [{ id: "model-a", metadata: { name: "A" } }], scope: " public " })
  catalog.data[0].id = "mutated"
  assert.equal((await settings.getModelCatalog()).data[0].id, "model-a")
  assert.equal((await settings.getModelCatalog()).scope, "public")
})
