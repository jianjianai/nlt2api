import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parse, stringify } from "yaml"
import { parseV2State, type AccountStatus, type V2State } from "../server/v2/state/schema"

interface LegacyRecord {
  [key: string]: unknown
}

function object(value: unknown, path: string): LegacyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as LegacyRecord
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${path} must be a string`)
  return value
}

function optionalTimestamp(value: unknown, fallback: string | null): string | null {
  if (value === null || value === undefined || value === "") return fallback
  const candidate = text(value, "timestamp")
  const date = new Date(candidate)
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid timestamp: ${candidate}`)
  return date.toISOString()
}

function status(value: unknown, cookie: string): AccountStatus {
  const allowed: readonly AccountStatus[] = ["unknown", "ready", "expired", "login_failed", "manual_cookie_required", "temporarily_unavailable"]
  if (typeof value === "string" && allowed.includes(value as AccountStatus)) {
    if (value === "ready" && !cookie) return "unknown"
    return value as AccountStatus
  }
  return cookie ? "ready" : "unknown"
}

function digest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex")
}

function keyPreview(secret: string): string {
  return `${secret.slice(0, 6)}...${secret.slice(-6)}`
}

function legacyToV2(value: unknown): V2State {
  const root = object(value, "legacy state")
  if (root.version !== 1) throw new Error("The input file must be the legacy version 1 state")
  const now = new Date().toISOString()
  const admin = object(root.admin ?? {}, "admin")
  const defaults = object(root.generationDefaults ?? {}, "generationDefaults")
  const rawAccounts = root.accounts
  if (!Array.isArray(rawAccounts)) throw new Error("accounts must be an array")
  const accounts = rawAccounts.map((entry, index) => {
    const account = object(entry, `accounts[${index}]`)
    const cookie = typeof account.cookie === "string" ? account.cookie : ""
    return {
      id: text(account.id, `accounts[${index}].id`),
      revision: 1,
      label: text(account.label, `accounts[${index}].label`),
      email: text(account.email, `accounts[${index}].email`),
      password: text(account.password, `accounts[${index}].password`, true),
      cookie,
      enabled: account.enabled !== false,
      status: status(account.status, cookie),
      lastLoginAt: optionalTimestamp(account.lastLoginAt, null),
      lastCheckedAt: optionalTimestamp(account.lastCheckedAt, null),
      lastError: account.lastError === null || account.lastError === undefined ? null : text(account.lastError, `accounts[${index}].lastError`, true),
      createdAt: optionalTimestamp(account.createdAt, now) ?? now,
      updatedAt: optionalTimestamp(account.updatedAt, now) ?? now
    }
  })

  const modelRoot = object(root.models ?? {}, "models")
  const modelData = Array.isArray(modelRoot.data) ? modelRoot.data : []
  if (modelData.some((model) => !model || typeof model !== "object" || Array.isArray(model))) {
    throw new Error("models.data must contain objects")
  }

  const rawKeys = Array.isArray(object(root.proxy ?? {}, "proxy").keys)
    ? object(root.proxy ?? {}, "proxy").keys as unknown[]
    : []
  const inferenceApiKeys = rawKeys.map((entry, index) => {
    const key = object(entry, `proxy.keys[${index}]`)
    const secret = text(key.value ?? key.secret, `proxy.keys[${index}].value`)
    const createdAt = optionalTimestamp(key.createdAt, now) ?? now
    const updatedAt = optionalTimestamp(key.updatedAt, createdAt) ?? createdAt
    return {
      id: text(key.id, `proxy.keys[${index}].id`),
      label: text(key.label ?? `Migrated key ${index + 1}`, `proxy.keys[${index}].label`),
      digest: digest(secret),
      preview: keyPreview(secret),
      enabled: key.enabled !== false,
      createdAt,
      updatedAt
    }
  })

  const candidate: V2State = {
    version: 2,
    admin: { passwordHash: typeof admin.passwordHash === "string" && admin.passwordHash ? admin.passwordHash : null },
    generationDefaults: {
      temperature: typeof defaults.temperature === "number" ? defaults.temperature : 0.7,
      maxTokens: typeof defaults.maxTokens === "number" ? Math.trunc(defaults.maxTokens) : 4_096,
      topP: typeof defaults.topP === "number" ? defaults.topP : 1
    },
    accounts,
    modelCatalog: {
      data: modelData as V2State["modelCatalog"]["data"],
      scope: typeof modelRoot.scope === "string" ? modelRoot.scope : null,
      fetchedAt: optionalTimestamp(modelRoot.fetchedAt, null)
    },
    inferenceApiKeys,
    requestLogging: { enabled: false }
  }
  parseV2State(candidate)
  return candidate
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const input = resolve(args.find((arg) => arg.startsWith("--input="))?.slice(8) ?? ".data/neuralwatt-accounts.yaml")
  const output = resolve(args.find((arg) => arg.startsWith("--output="))?.slice(9) ?? `${input}.v2.yaml`)
  if (input === output) throw new Error("Refusing to overwrite the input; choose a separate --output path")
  const legacy = parse(await readFile(input, "utf8"))
  const migrated = legacyToV2(legacy)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, stringify(migrated), { encoding: "utf8", mode: 0o600, flag: "wx" })
  await chmod(output, 0o600).catch(() => undefined)
  process.stdout.write(`Migrated ${migrated.accounts.length} accounts and ${migrated.inferenceApiKeys.length} inference keys to ${output}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
