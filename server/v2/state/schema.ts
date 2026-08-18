import { ApiError } from "../shared/errors"
import { cloneJson, isJsonObject, type JsonObject } from "../shared/json"
import { MAX_PORTAL_JSON_BYTES } from "../shared/limits"

export const ACCOUNT_STATUSES = [
  "unknown",
  "ready",
  "expired",
  "login_failed",
  "manual_cookie_required",
  "temporarily_unavailable"
] as const

export type AccountStatus = typeof ACCOUNT_STATUSES[number]

export interface StoredAccount {
  id: string
  revision: number
  label: string
  email: string
  password: string
  cookie: string
  enabled: boolean
  status: AccountStatus
  lastLoginAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type AccountRecord = StoredAccount

export interface PublicAccount {
  id: string
  revision: number
  label: string
  email: string
  enabled: boolean
  status: AccountStatus
  hasPassword: boolean
  hasCookie: boolean
  lastLoginAt: string | null
  lastCheckedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface StoredInferenceApiKey {
  id: string
  label: string
  digest: string
  preview: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface PublicInferenceApiKey {
  id: string
  label: string
  preview: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface GenerationDefaults {
  temperature: number
  maxTokens: number
  topP: number
}

export interface StoredModelCatalog {
  data: JsonObject[]
  scope: string | null
  fetchedAt: string | null
}

export interface RequestLoggingSettings {
  enabled: boolean
}

export interface V2State {
  version: 2
  admin: {
    passwordHash: string | null
  }
  generationDefaults: GenerationDefaults
  accounts: StoredAccount[]
  modelCatalog: StoredModelCatalog
  inferenceApiKeys: StoredInferenceApiKey[]
  requestLogging: RequestLoggingSettings
}

const ROOT_KEYS = ["version", "admin", "generationDefaults", "accounts", "modelCatalog", "inferenceApiKeys", "requestLogging"]
const ADMIN_KEYS = ["passwordHash"]
const GENERATION_KEYS = ["temperature", "maxTokens", "topP"]
const ACCOUNT_KEYS = [
  "id",
  "revision",
  "label",
  "email",
  "password",
  "cookie",
  "enabled",
  "status",
  "lastLoginAt",
  "lastCheckedAt",
  "lastError",
  "createdAt",
  "updatedAt"
]
const MODEL_CATALOG_KEYS = ["data", "scope", "fetchedAt"]
const API_KEY_KEYS = ["id", "label", "digest", "preview", "enabled", "createdAt", "updatedAt"]
const REQUEST_LOGGING_KEYS = ["enabled"]
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function schemaError(message: string, code = "state_schema_invalid"): never {
  throw new ApiError(message, { status: 500, code })
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) schemaError(`${path} must be an object`)
  return value
}

function exactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    schemaError(`${path} contains missing or unknown properties`)
  }
}

function stringAt(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
    schemaError(`${path} must be a string between ${allowEmpty ? 0 : 1} and ${maximum} characters`)
  }
  return value
}

function nullableStringAt(value: unknown, path: string, maximum: number): string | null {
  if (value === null) return null
  return stringAt(value, path, maximum)
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") schemaError(`${path} must be a boolean`)
  return value
}

function finiteNumberAt(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    schemaError(`${path} is outside its supported range`)
  }
  return value
}

function integerAt(value: unknown, path: string, minimum: number, maximum: number): number {
  const result = finiteNumberAt(value, path, minimum, maximum)
  if (!Number.isSafeInteger(result)) schemaError(`${path} must be an integer`)
  return result
}

function timestampAt(value: unknown, path: string): string {
  const result = stringAt(value, path, 40)
  const parsed = new Date(result)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) schemaError(`${path} must be a canonical ISO timestamp`)
  return result
}

function nullableTimestampAt(value: unknown, path: string): string | null {
  if (value === null) return null
  return timestampAt(value, path)
}

function identifierAt(value: unknown, path: string): string {
  const result = stringAt(value, path, 128)
  if (!ID_PATTERN.test(result)) schemaError(`${path} contains invalid characters`)
  return result
}

function emailAt(value: unknown, path: string): string {
  const result = stringAt(value, path, 254)
  if (result !== result.trim() || !EMAIL_PATTERN.test(result)) schemaError(`${path} is not a valid email address`)
  return result
}

function jsonValueAt(value: unknown, path: string, seen = new WeakSet<object>(), depth = 0): void {
  if (depth > 64) schemaError(`${path} exceeds the maximum JSON nesting depth`)
  if (value === null || typeof value === "boolean") return
  if (typeof value === "string") {
    if (value.length > 1_000_000) schemaError(`${path} contains an oversized string`)
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) schemaError(`${path} contains a non-finite number`)
    return
  }
  if (typeof value !== "object") schemaError(`${path} is not JSON-compatible`)
  if (seen.has(value)) schemaError(`${path} contains a cycle`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => jsonValueAt(item, `${path}[${index}]`, seen, depth + 1))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) schemaError(`${path} must contain plain JSON objects`)
    for (const [key, child] of Object.entries(value)) {
      if (key.length > 1_000) schemaError(`${path} contains an oversized property name`)
      jsonValueAt(child, `${path}.${key}`, seen, depth + 1)
    }
  }
  seen.delete(value)
}

function validateGenerationDefaults(value: unknown): void {
  const record = objectAt(value, "generationDefaults")
  exactKeys(record, GENERATION_KEYS, "generationDefaults")
  finiteNumberAt(record.temperature, "generationDefaults.temperature", 0, 2)
  integerAt(record.maxTokens, "generationDefaults.maxTokens", 1, 1_000_000)
  finiteNumberAt(record.topP, "generationDefaults.topP", 0, 1)
}

function validateAccount(value: unknown, index: number): StoredAccount {
  const path = `accounts[${index}]`
  const record = objectAt(value, path)
  exactKeys(record, ACCOUNT_KEYS, path)
  const id = identifierAt(record.id, `${path}.id`)
  const revision = integerAt(record.revision, `${path}.revision`, 1, Number.MAX_SAFE_INTEGER)
  const label = stringAt(record.label, `${path}.label`, 80)
  if (label !== label.trim()) schemaError(`${path}.label must not have surrounding whitespace`)
  const email = emailAt(record.email, `${path}.email`)
  const password = stringAt(record.password, `${path}.password`, 1_024)
  const cookie = stringAt(record.cookie, `${path}.cookie`, 16_384, true)
  if (cookie !== cookie.trim() || /[\r\n]/.test(cookie)) schemaError(`${path}.cookie is not a valid Cookie header`)
  const enabled = booleanAt(record.enabled, `${path}.enabled`)
  if (typeof record.status !== "string" || !ACCOUNT_STATUSES.includes(record.status as AccountStatus)) {
    schemaError(`${path}.status is invalid`)
  }
  const status = record.status as AccountStatus
  if (status === "ready" && !cookie) schemaError(`${path} cannot be ready without a session cookie`)
  return {
    id,
    revision,
    label,
    email,
    password,
    cookie,
    enabled,
    status,
    lastLoginAt: nullableTimestampAt(record.lastLoginAt, `${path}.lastLoginAt`),
    lastCheckedAt: nullableTimestampAt(record.lastCheckedAt, `${path}.lastCheckedAt`),
    lastError: nullableStringAt(record.lastError, `${path}.lastError`, 240),
    createdAt: timestampAt(record.createdAt, `${path}.createdAt`),
    updatedAt: timestampAt(record.updatedAt, `${path}.updatedAt`)
  }
}

function validateModelCatalog(value: unknown): void {
  const record = objectAt(value, "modelCatalog")
  exactKeys(record, MODEL_CATALOG_KEYS, "modelCatalog")
  if (!Array.isArray(record.data) || record.data.length > 10_000) schemaError("modelCatalog.data must be a bounded array")
  record.data.forEach((model, index) => {
    if (!isJsonObject(model)) schemaError(`modelCatalog.data[${index}] must be an object`)
    jsonValueAt(model, `modelCatalog.data[${index}]`)
  })
  if (Buffer.byteLength(JSON.stringify(record.data), "utf8") > MAX_PORTAL_JSON_BYTES) {
    schemaError("modelCatalog.data exceeds the maximum serialized size")
  }
  if (record.scope !== null) stringAt(record.scope, "modelCatalog.scope", 200)
  nullableTimestampAt(record.fetchedAt, "modelCatalog.fetchedAt")
}

function validateInferenceApiKey(value: unknown, index: number): StoredInferenceApiKey {
  const path = `inferenceApiKeys[${index}]`
  const record = objectAt(value, path)
  exactKeys(record, API_KEY_KEYS, path)
  const digest = stringAt(record.digest, `${path}.digest`, 64)
  if (!SHA256_PATTERN.test(digest)) schemaError(`${path}.digest must be a SHA-256 hex digest`)
  const label = stringAt(record.label, `${path}.label`, 80)
  if (label !== label.trim()) schemaError(`${path}.label must not have surrounding whitespace`)
  const preview = stringAt(record.preview, `${path}.preview`, 40)
  if (!/^[A-Za-z0-9_-]{1,8}\.\.\.[A-Za-z0-9_-]{4,8}$/.test(preview)) {
    schemaError(`${path}.preview is not a non-secret key preview`)
  }
  return {
    id: identifierAt(record.id, `${path}.id`),
    label,
    digest,
    preview,
    enabled: booleanAt(record.enabled, `${path}.enabled`),
    createdAt: timestampAt(record.createdAt, `${path}.createdAt`),
    updatedAt: timestampAt(record.updatedAt, `${path}.updatedAt`)
  }
}

export function validateV2State(value: unknown): asserts value is V2State {
  const root = objectAt(value, "state")
  if (root.version !== 2) schemaError("Only state version 2 is supported", "state_version_unsupported")
  exactKeys(root, ROOT_KEYS, "state")

  const admin = objectAt(root.admin, "admin")
  exactKeys(admin, ADMIN_KEYS, "admin")
  if (admin.passwordHash !== null) stringAt(admin.passwordHash, "admin.passwordHash", 512)
  validateGenerationDefaults(root.generationDefaults)

  if (!Array.isArray(root.accounts) || root.accounts.length > 10_000) schemaError("accounts must be a bounded array")
  const accounts = root.accounts.map(validateAccount)
  const accountIds = new Set<string>()
  const accountEmails = new Set<string>()
  for (const account of accounts) {
    const normalizedEmail = account.email.toLocaleLowerCase("en-US")
    if (accountIds.has(account.id)) schemaError("Account ids must be unique")
    if (accountEmails.has(normalizedEmail)) schemaError("Account emails must be unique")
    accountIds.add(account.id)
    accountEmails.add(normalizedEmail)
  }

  validateModelCatalog(root.modelCatalog)
  const requestLogging = objectAt(root.requestLogging, "requestLogging")
  exactKeys(requestLogging, REQUEST_LOGGING_KEYS, "requestLogging")
  booleanAt(requestLogging.enabled, "requestLogging.enabled")
  if (!Array.isArray(root.inferenceApiKeys) || root.inferenceApiKeys.length > 10_000) {
    schemaError("inferenceApiKeys must be a bounded array")
  }
  const apiKeys = root.inferenceApiKeys.map(validateInferenceApiKey)
  const apiKeyIds = new Set<string>()
  const apiKeyDigests = new Set<string>()
  for (const key of apiKeys) {
    if (apiKeyIds.has(key.id)) schemaError("Inference API key ids must be unique")
    if (apiKeyDigests.has(key.digest)) schemaError("Inference API key digests must be unique")
    apiKeyIds.add(key.id)
    apiKeyDigests.add(key.digest)
  }
}

export function parseV2State(value: unknown): V2State {
  const candidate = isJsonObject(value) && value.version === 2 && !("requestLogging" in value)
    ? { ...cloneJson(value), requestLogging: { enabled: false } }
    : value
  validateV2State(candidate)
  return cloneJson(candidate)
}

export function createEmptyV2State(): V2State {
  return {
    version: 2,
    admin: { passwordHash: null },
    generationDefaults: { temperature: 0.7, maxTokens: 4_096, topP: 1 },
    accounts: [],
    modelCatalog: { data: [], scope: null, fetchedAt: null },
    inferenceApiKeys: [],
    requestLogging: { enabled: false }
  }
}

export function toPublicAccount(account: StoredAccount): PublicAccount {
  return {
    id: account.id,
    revision: account.revision,
    label: account.label,
    email: account.email,
    enabled: account.enabled,
    status: account.status,
    hasPassword: account.password.length > 0,
    hasCookie: account.cookie.length > 0,
    lastLoginAt: account.lastLoginAt,
    lastCheckedAt: account.lastCheckedAt,
    lastError: account.lastError,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  }
}

export function toPublicInferenceApiKey(key: StoredInferenceApiKey): PublicInferenceApiKey {
  return {
    id: key.id,
    label: key.label,
    preview: key.preview,
    enabled: key.enabled,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt
  }
}
