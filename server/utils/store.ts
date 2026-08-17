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

export interface AccountStore {
  version: 1
  proxy: {
    apiKey: string
  }
  admin: {
    passwordHash: string
    sessionSecret: string
  }
  accounts: StoredAccount[]
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

function normalizeStore(value: unknown): AccountStore {
  const record = isRecord(value) ? value : {}
  const proxy = isRecord(record.proxy) ? record.proxy : {}
  const admin = isRecord(record.admin) ? record.admin : {}
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.map(normalizeAccount).filter((account): account is StoredAccount => account !== null)
    : []

  return {
    version: 1,
    proxy: {
      apiKey: asString(proxy.apiKey)
    },
    admin: {
      passwordHash: asString(admin.passwordHash),
      sessionSecret: asString(admin.sessionSecret)
    },
    accounts
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
  if (!store.proxy.apiKey) {
    store.proxy.apiKey = process.env.NEURALWATT_PROXY_KEY || generateProxyKey()
    console.info(`Generated local proxy API key: ${store.proxy.apiKey}`)
  }
  if (!store.admin.sessionSecret) {
    store.admin.sessionSecret = randomBytes(32).toString("base64url")
  }

  loadedStore = store
  if (
    !fileExists ||
    !isRecord(value) ||
    !isRecord(value.proxy) ||
    !asString(value.proxy.apiKey) ||
    !isRecord(value.admin) ||
    !asString(value.admin.sessionSecret)
  ) {
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

export async function getProxyKey(): Promise<string> {
  return process.env.NEURALWATT_PROXY_KEY || (await loadStore()).proxy.apiKey
}

export async function rotateProxyKey(): Promise<string> {
  return updateStore((store) => {
    store.proxy.apiKey = generateProxyKey()
    return store.proxy.apiKey
  })
}

export async function setProxyKey(apiKey: string): Promise<string> {
  const key = apiKey.trim()
  if (key.length < 8) {
    throw new AppError("API key must be at least 8 characters", 400, "invalid_proxy_key")
  }
  return updateStore((store) => {
    store.proxy.apiKey = key
    return store.proxy.apiKey
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
