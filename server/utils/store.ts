import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomBytes, randomUUID } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { parse, stringify } from "yaml"
import { AppError } from "./errors"

export type AccountStatus = "unknown" | "ready" | "expired" | "login_failed" | "manual_cookie_required"

export interface StoredAccount {
  id: string
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

export type StoredModel = Record<string, unknown>

export interface StoredModelCatalog {
  data: StoredModel[]
  scope: string | null
  fetchedAt: string | null
}

export interface StoredProxyKey {
  id: string
  label: string
  value: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface GenerationDefaults {
  temperature: number
  maxTokens: number
  topP: number
}

export interface AccountStore {
  version: 1
  proxy: {
    keys: StoredProxyKey[]
  }
  admin: {
    passwordHash: string
    sessionSecret: string
  }
  generationDefaults: GenerationDefaults
  accounts: StoredAccount[]
  models: StoredModelCatalog
}

export interface PublicProxyKey {
  id: string
  label: string
  value: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface PublicAccount {
  id: string
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

const dataFile = resolve(process.env.NEURALWATT_DATA_FILE ?? join(process.cwd(), ".data", "neuralwatt-accounts.yaml"))
let loadedStore: AccountStore | undefined
let writeChain: Promise<unknown> = Promise.resolve()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function normalizeAccount(value: unknown): StoredAccount | null {
  if (!isRecord(value)) {
    return null
  }

  const email = asString(value.email).trim()
  if (!email) {
    return null
  }

  const now = new Date().toISOString()
  const status = asString(value.status, "unknown") as AccountStatus
  const validStatus: AccountStatus[] = ["unknown", "ready", "expired", "login_failed", "manual_cookie_required"]

  return {
    id: asString(value.id, randomUUID()),
    label: asString(value.label, email),
    email,
    password: asString(value.password),
    cookie: asString(value.cookie),
    enabled: asBoolean(value.enabled, true),
    status: validStatus.includes(status) ? status : "unknown",
    lastLoginAt: asNullableString(value.lastLoginAt),
    lastCheckedAt: asNullableString(value.lastCheckedAt),
    lastError: asNullableString(value.lastError),
    createdAt: asString(value.createdAt, now),
    updatedAt: asString(value.updatedAt, now)
  }
}

export function filterCatalogModels(value: unknown): StoredModel[] {
  if (!Array.isArray(value)) return []

  const ids = new Set<string>()
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id) return []
    const id = candidate.id
    if (id.toLowerCase().endsWith("-flex") || ids.has(id)) return []
    // This is the 0731 canary alias of the canonical deepseek-v4-flash entry.
    if (id === "deepseek-ai/DeepSeek-V4-Flash") return []
    ids.add(id)
    return [candidate]
  })
}

function normalizeModelCatalog(value: unknown): StoredModelCatalog {
  const record = isRecord(value) ? value : {}
  return {
    data: filterCatalogModels(record.data),
    scope: asNullableString(record.scope),
    fetchedAt: asNullableString(record.fetchedAt)
  }
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback
}

function normalizeGenerationDefaults(value: unknown): GenerationDefaults {
  const record = isRecord(value) ? value : {}
  const maxTokens = boundedNumber(record.maxTokens, 4096, 50, 8150)
  return {
    temperature: boundedNumber(record.temperature, 0.7, 0, 2),
    maxTokens: Number.isInteger(maxTokens) ? maxTokens : 4096,
    topP: boundedNumber(record.topP, 1, 0.1, 1)
  }
}

function normalizeProxyKey(value: unknown): StoredProxyKey | null {
  if (!isRecord(value)) return null

  const key = asString(value.value).trim()
  if (!key) return null

  const now = new Date().toISOString()
  return {
    id: asString(value.id, randomUUID()),
    label: asString(value.label, "Default key").trim() || "Default key",
    value: key,
    enabled: asBoolean(value.enabled, true),
    createdAt: asString(value.createdAt, now),
    updatedAt: asString(value.updatedAt, now)
  }
}

function normalizeStore(value: unknown): AccountStore {
  const record = isRecord(value) ? value : {}
  const proxy = isRecord(record.proxy) ? record.proxy : {}
  const admin = isRecord(record.admin) ? record.admin : {}
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.map(normalizeAccount).filter((account): account is StoredAccount => account !== null)
    : []
  const keys = Array.isArray(proxy.keys)
    ? proxy.keys.map(normalizeProxyKey).filter((key): key is StoredProxyKey => key !== null)
    : []
  const legacyApiKey = asString(proxy.apiKey).trim()

  if (keys.length === 0 && legacyApiKey) {
    const now = new Date().toISOString()
    keys.push({ id: randomUUID(), label: "Default key", value: legacyApiKey, enabled: true, createdAt: now, updatedAt: now })
  }

  return {
    version: 1,
    proxy: {
      keys
    },
    admin: {
      passwordHash: asString(admin.passwordHash),
      sessionSecret: asString(admin.sessionSecret)
    },
    generationDefaults: normalizeGenerationDefaults(record.generationDefaults),
    accounts,
    models: normalizeModelCatalog(record.models)
  }
}

function generateProxyKey(): string {
  return `nw-local-${randomBytes(32).toString("base64url")}`
}

async function persistStore(store: AccountStore): Promise<void> {
  await mkdir(dirname(dataFile), { recursive: true })
  const content = stringify(store)
  const temporaryFile = `${dataFile}.${randomUUID()}.tmp`

  try {
    await writeFile(temporaryFile, content, { encoding: "utf8", mode: 0o600 })
    try {
      await rename(temporaryFile, dataFile)
    } catch {
      await writeFile(dataFile, content, { encoding: "utf8", mode: 0o600 })
    }
    try {
      await chmod(dataFile, 0o600)
    } catch {
      // Windows may not support POSIX mode bits; the file still stays in .data.
    }
  } finally {
    try {
      await unlink(temporaryFile)
    } catch {
      // The temporary file is harmless if the platform already removed it.
    }
  }
}

async function loadStore(): Promise<AccountStore> {
  if (loadedStore) {
    return loadedStore
  }

  let value: unknown = {}
  let fileExists = true
  try {
    value = parse(await readFile(dataFile, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AppError("The account YAML file could not be read", 500, "account_store_read_failed")
    }
    fileExists = false
  }

  const store = normalizeStore(value)
  const storedKeys = isRecord(value) && isRecord(value.proxy) && Array.isArray(value.proxy.keys)
  const storedAdminSession = isRecord(value) && isRecord(value.admin) && Boolean(asString(value.admin.sessionSecret))
  const storedGenerationDefaults = isRecord(value) && isRecord(value.generationDefaults)
  const configuredKey = process.env.NEURALWATT_PROXY_KEY?.trim()
  if (!storedKeys && configuredKey && !store.proxy.keys.some((key) => key.value === configuredKey)) {
    const now = new Date().toISOString()
    store.proxy.keys.push({ id: randomUUID(), label: "Environment key", value: configuredKey, enabled: true, createdAt: now, updatedAt: now })
  }
  if (store.proxy.keys.length === 0) {
    const value = configuredKey || generateProxyKey()
    const now = new Date().toISOString()
    store.proxy.keys.push({ id: randomUUID(), label: configuredKey ? "Environment key" : "Default key", value, enabled: true, createdAt: now, updatedAt: now })
    if (!configuredKey) console.info(`Generated local proxy API key: ${value}`)
  }
  if (!store.admin.sessionSecret) {
    store.admin.sessionSecret = randomBytes(32).toString("base64url")
  }

  loadedStore = store
  if (!fileExists || !storedKeys || !storedAdminSession || !storedGenerationDefaults) {
    await persistStore(store)
  }

  return store
}

async function updateStore<T>(mutator: (store: AccountStore) => Promise<T> | T): Promise<T> {
  const operation = writeChain.then(async () => {
    const store = await loadStore()
    const result = await mutator(store)
    await persistStore(store)
    return result
  })
  writeChain = operation.catch(() => undefined)
  return operation
}

export async function getGenerationDefaults(): Promise<GenerationDefaults> {
  return { ...(await loadStore()).generationDefaults }
}

export async function updateGenerationDefaults(input: GenerationDefaults): Promise<GenerationDefaults> {
  const defaults = normalizeGenerationDefaults(input)
  if (defaults.temperature !== input.temperature || defaults.maxTokens !== input.maxTokens || defaults.topP !== input.topP) {
    throw new AppError("Generation defaults are outside the supported range", 400, "invalid_generation_defaults")
  }

  return updateStore((store) => {
    store.generationDefaults = defaults
    return { ...defaults }
  })
}

export async function getAdminPasswordHash(): Promise<string> {
  return (await loadStore()).admin.passwordHash
}

export async function setAdminPasswordHash(passwordHash: string): Promise<void> {
  await updateStore((store) => {
    store.admin.passwordHash = passwordHash
  })
}

export async function getAdminSessionSecret(): Promise<string> {
  return (await loadStore()).admin.sessionSecret
}

export async function rotateAdminSessionSecret(): Promise<string> {
  return updateStore((store) => {
    store.admin.sessionSecret = randomBytes(32).toString("base64url")
    return store.admin.sessionSecret
  })
}

export async function listProxyKeys(): Promise<PublicProxyKey[]> {
  const store = await loadStore()
  return store.proxy.keys.map((key) => ({ ...key }))
}

export async function createProxyKey(input: { label: string }): Promise<PublicProxyKey> {
  const label = input.label.trim() || "Untitled key"
  if (label.length > 80) {
    throw new AppError("Key label must be 80 characters or fewer", 400, "invalid_proxy_key", "label")
  }

  return updateStore((store) => {
    const now = new Date().toISOString()
    const key: StoredProxyKey = {
      id: randomUUID(),
      label,
      value: generateProxyKey(),
      enabled: true,
      createdAt: now,
      updatedAt: now
    }
    store.proxy.keys.push(key)
    return { ...key }
  })
}

export async function updateProxyKey(id: string, input: { label?: string; enabled?: boolean }): Promise<PublicProxyKey> {
  return updateStore((store) => {
    const key = store.proxy.keys.find((candidate) => candidate.id === id)
    if (!key) throw new AppError("Proxy key not found", 404, "proxy_key_not_found")

    if (input.label !== undefined) {
      const label = input.label.trim()
      if (!label || label.length > 80) {
        throw new AppError("Key label must be between 1 and 80 characters", 400, "invalid_proxy_key", "label")
      }
      key.label = label
    }
    if (input.enabled !== undefined) key.enabled = input.enabled
    key.updatedAt = new Date().toISOString()
    return { ...key }
  })
}

export async function deleteProxyKey(id: string): Promise<void> {
  await updateStore((store) => {
    const index = store.proxy.keys.findIndex((candidate) => candidate.id === id)
    if (index < 0) throw new AppError("Proxy key not found", 404, "proxy_key_not_found")
    if (store.proxy.keys.length === 1) {
      throw new AppError("At least one proxy key must remain", 400, "last_proxy_key")
    }
    store.proxy.keys.splice(index, 1)
  })
}

export async function getSavedModelCatalog(): Promise<StoredModelCatalog> {
  const catalog = (await loadStore()).models
  return { ...catalog, data: [...catalog.data] }
}

export async function saveModelCatalog(input: { data: unknown; scope: string | null }): Promise<StoredModelCatalog> {
  return updateStore((store) => {
    const catalog: StoredModelCatalog = {
      data: filterCatalogModels(input.data),
      scope: input.scope?.trim() || null,
      fetchedAt: new Date().toISOString()
    }
    store.models = catalog
    return { ...catalog, data: [...catalog.data] }
  })
}


export function toPublicAccount(account: StoredAccount): PublicAccount {
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    enabled: account.enabled,
    status: account.status,
    hasPassword: Boolean(account.password),
    hasCookie: Boolean(account.cookie),
    lastLoginAt: account.lastLoginAt,
    lastCheckedAt: account.lastCheckedAt,
    lastError: account.lastError,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  }
}

export async function listAccounts(): Promise<PublicAccount[]> {
  const store = await loadStore()
  return store.accounts.map(toPublicAccount)
}

export async function getAccount(id: string): Promise<StoredAccount> {
  const store = await loadStore()
  const account = store.accounts.find((candidate) => candidate.id === id)
  if (!account) {
    throw new AppError("Account not found", 404, "account_not_found")
  }
  return { ...account }
}

export async function getEnabledAccounts(): Promise<StoredAccount[]> {
  const store = await loadStore()
  return store.accounts.filter((account) => account.enabled).map((account) => ({ ...account }))
}

export async function createAccount(input: { label: string; email: string; password: string }): Promise<PublicAccount> {
  const label = input.label.trim()
  const email = input.email.trim()
  if (!label || !email || !input.password) {
    throw new AppError("label, email and password are required", 400, "invalid_account", "account")
  }

  return updateStore((store) => {
    const now = new Date().toISOString()
    const account: StoredAccount = {
      id: randomUUID(),
      label,
      email,
      password: input.password,
      cookie: "",
      enabled: true,
      status: "unknown",
      lastLoginAt: null,
      lastCheckedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    }
    store.accounts.push(account)
    return toPublicAccount(account)
  })
}

export async function updateAccount(
  id: string,
  input: { label?: string; email?: string; password?: string; enabled?: boolean }
): Promise<PublicAccount> {
  return updateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id)
    if (!account) {
      throw new AppError("Account not found", 404, "account_not_found")
    }

    if (input.label !== undefined && input.label.trim()) account.label = input.label.trim()
    if (input.email !== undefined && input.email.trim()) account.email = input.email.trim()
    if (input.password !== undefined && input.password) account.password = input.password
    if (input.enabled !== undefined) account.enabled = input.enabled
    account.updatedAt = new Date().toISOString()
    return toPublicAccount(account)
  })
}

export async function deleteAccount(id: string): Promise<void> {
  await updateStore((store) => {
    const index = store.accounts.findIndex((candidate) => candidate.id === id)
    if (index < 0) {
      throw new AppError("Account not found", 404, "account_not_found")
    }
    store.accounts.splice(index, 1)
  })
}

export async function setAccountCookie(id: string, cookie: string): Promise<PublicAccount> {
  if (!cookie.trim()) {
    throw new AppError("A non-empty Cookie header is required", 400, "invalid_cookie", "cookie")
  }

  return updateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id)
    if (!account) {
      throw new AppError("Account not found", 404, "account_not_found")
    }
    account.cookie = cookie.trim()
    account.status = "unknown"
    account.lastCheckedAt = null
    account.lastError = null
    account.updatedAt = new Date().toISOString()
    return toPublicAccount(account)
  })
}

export async function recordAccountLogin(id: string, cookie: string): Promise<void> {
  await updateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id)
    if (!account) return
    const now = new Date().toISOString()
    account.cookie = cookie
    account.status = "ready"
    account.lastLoginAt = now
    account.lastCheckedAt = now
    account.lastError = null
    account.updatedAt = now
  })
}

export async function recordAccountStatus(id: string, status: AccountStatus, errorMessage: string | null): Promise<void> {
  await updateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id)
    if (!account) return
    account.status = status
    account.lastCheckedAt = new Date().toISOString()
    account.lastError = errorMessage ? errorMessage.slice(0, 240) : null
    account.updatedAt = new Date().toISOString()
  })
}
