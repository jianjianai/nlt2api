import { randomUUID } from "node:crypto"
import { ApiError, invalidRequest } from "../shared/errors"
import { cloneJson } from "../shared/json"
import type { StateRepository } from "./file-repository"
import {
  ACCOUNT_STATUSES,
  toPublicAccount,
  type AccountStatus,
  type PublicAccount,
  type StoredAccount
} from "./schema"

export interface AccountServiceOptions {
  now?: () => number
  createId?: () => string
}

export interface CreateAccountInput {
  label: string
  email: string
  password: string
  cookie?: string | null
  enabled?: boolean
}

export interface UpdateAccountInput {
  label?: string
  email?: string
  password?: string
  cookie?: string | null
  enabled?: boolean
}

export interface AccountWriteOptions {
  expectedRevision?: number
}

export interface UpdateAccountRuntimeInput {
  status: AccountStatus
  cookie?: string | null
  lastError?: string | null
  markLogin?: boolean
}

function notFound(): ApiError {
  return new ApiError("Account not found", { status: 404, code: "account_not_found" })
}

function conflict(message: string, code: string): ApiError {
  return new ApiError(message, { status: 409, code })
}

function requireText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") throw invalidRequest(`${name} must be a string`, "invalid_account", name)
  const result = value.trim()
  if (!result || result.length > maximum) {
    throw invalidRequest(`${name} must contain between 1 and ${maximum} characters`, "invalid_account", name)
  }
  return result
}

function requirePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) {
    throw invalidRequest("password must contain between 1 and 1024 characters", "invalid_account", "password")
  }
  return value
}

function requireEmail(value: unknown): string {
  const email = requireText(value, "email", 254)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalidRequest("email must be a valid address", "invalid_account", "email")
  }
  return email
}

function optionalCookie(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return value === null ? "" : undefined
  const cookie = value.trim()
  if (!cookie || cookie.length > 16_384 || /[\r\n]/.test(cookie)) {
    throw invalidRequest("cookie must be a non-empty Cookie header no longer than 16384 characters", "invalid_account", "cookie")
  }
  return cookie
}

function emailKey(email: string): string {
  return email.toLocaleLowerCase("en-US")
}

export class AccountService {
  readonly #repository: StateRepository
  readonly #now: () => number
  readonly #createId: () => string

  constructor(repository: StateRepository, options: AccountServiceOptions = {}) {
    this.#repository = repository
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? randomUUID
  }

  async listAccounts(): Promise<PublicAccount[]> {
    const state = await this.#repository.snapshot()
    return cloneJson(state.accounts.map(toPublicAccount))
  }

  async getAccountForPortal(id: string): Promise<StoredAccount> {
    const state = await this.#repository.snapshot()
    const account = state.accounts.find((candidate) => candidate.id === id)
    if (!account) throw notFound()
    return cloneJson(account)
  }

  async getAccountRecord(id: string): Promise<StoredAccount> {
    return this.getAccountForPortal(id)
  }

  async getEnabledAccountsForPortal(): Promise<StoredAccount[]> {
    const state = await this.#repository.snapshot()
    return cloneJson(state.accounts.filter((account) => account.enabled))
  }

  async listEnabledAccounts(): Promise<StoredAccount[]> {
    return this.getEnabledAccountsForPortal()
  }

  async createAccount(input: CreateAccountInput): Promise<PublicAccount> {
    const label = requireText(input.label, "label", 80)
    const email = requireEmail(input.email)
    const password = requirePassword(input.password)
    const cookie = optionalCookie(input.cookie) ?? ""
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw invalidRequest("enabled must be a boolean", "invalid_account", "enabled")
    }

    return this.#repository.transact((state) => {
      if (state.accounts.some((account) => emailKey(account.email) === emailKey(email))) {
        throw conflict("An account with this email already exists", "account_email_exists")
      }
      const now = this.timestamp()
      const account: StoredAccount = {
        id: this.#createId(),
        revision: 1,
        label,
        email,
        password,
        cookie,
        enabled: input.enabled ?? true,
        status: "unknown",
        lastLoginAt: null,
        lastCheckedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now
      }
      state.accounts.push(account)
      return toPublicAccount(account)
    })
  }

  async updateAccount(id: string, input: UpdateAccountInput, options: AccountWriteOptions = {}): Promise<PublicAccount> {
    if (input.label === undefined && input.email === undefined && input.password === undefined
      && input.cookie === undefined && input.enabled === undefined) {
      throw invalidRequest("At least one account property must be provided", "invalid_account", "account")
    }
    const label = input.label === undefined ? undefined : requireText(input.label, "label", 80)
    const email = input.email === undefined ? undefined : requireEmail(input.email)
    const password = input.password === undefined ? undefined : requirePassword(input.password)
    const replacementCookie = optionalCookie(input.cookie)
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw invalidRequest("enabled must be a boolean", "invalid_account", "enabled")
    }

    return this.#repository.transact((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id)
      if (!account) throw notFound()
      this.assertRevision(account, options.expectedRevision)
      if (email !== undefined && emailKey(email) !== emailKey(account.email)
        && state.accounts.some((candidate) => candidate.id !== id && emailKey(candidate.email) === emailKey(email))) {
        throw conflict("An account with this email already exists", "account_email_exists")
      }

      const credentialsChanged = (email !== undefined && email !== account.email)
        || (password !== undefined && password !== account.password)
      if (label !== undefined) account.label = label
      if (email !== undefined) account.email = email
      if (password !== undefined) account.password = password
      if (input.enabled !== undefined) account.enabled = input.enabled

      if (replacementCookie !== undefined) {
        account.cookie = replacementCookie
        this.resetSessionMetadata(account)
      } else if (credentialsChanged) {
        account.cookie = ""
        this.resetSessionMetadata(account)
      }

      account.revision += 1
      account.updatedAt = this.timestamp()
      return toPublicAccount(account)
    })
  }

  async deleteAccount(id: string, options: AccountWriteOptions = {}): Promise<void> {
    await this.#repository.transact((state) => {
      const index = state.accounts.findIndex((candidate) => candidate.id === id)
      if (index < 0) throw notFound()
      this.assertRevision(state.accounts[index], options.expectedRevision)
      state.accounts.splice(index, 1)
    })
  }

  async setAccountSession(
    id: string,
    cookieInput: string,
    options: AccountWriteOptions = {}
  ): Promise<PublicAccount> {
    const cookie = optionalCookie(cookieInput)
    if (!cookie) throw invalidRequest("cookie is required", "invalid_account", "cookie")
    return this.#repository.transact((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id)
      if (!account) throw notFound()
      this.assertRevision(account, options.expectedRevision)
      const now = this.timestamp()
      account.cookie = cookie
      account.status = "ready"
      account.lastLoginAt = now
      account.lastCheckedAt = now
      account.lastError = null
      account.revision += 1
      account.updatedAt = now
      return toPublicAccount(account)
    })
  }

  async clearAccountSession(
    id: string,
    status: Exclude<AccountStatus, "ready"> = "expired",
    errorMessage: string | null = null,
    options: AccountWriteOptions = {}
  ): Promise<PublicAccount> {
    if (!ACCOUNT_STATUSES.includes(status)) {
      throw invalidRequest("status must describe an unavailable session", "invalid_account_status", "status")
    }
    const error = this.errorMessage(errorMessage)
    return this.#repository.transact((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id)
      if (!account) throw notFound()
      this.assertRevision(account, options.expectedRevision)
      const now = this.timestamp()
      account.cookie = ""
      account.status = status
      account.lastCheckedAt = now
      account.lastError = error
      account.revision += 1
      account.updatedAt = now
      return toPublicAccount(account)
    })
  }

  async recordAccountStatus(
    id: string,
    status: AccountStatus,
    errorMessage: string | null,
    options: AccountWriteOptions = {}
  ): Promise<PublicAccount> {
    if (!ACCOUNT_STATUSES.includes(status)) {
      throw invalidRequest("status is invalid", "invalid_account_status", "status")
    }
    const error = this.errorMessage(errorMessage)
    return this.#repository.transact((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id)
      if (!account) throw notFound()
      this.assertRevision(account, options.expectedRevision)
      if (status === "ready" && !account.cookie) {
        throw conflict("An account without a session cookie cannot be ready", "account_session_missing")
      }
      const now = this.timestamp()
      account.status = status
      account.lastCheckedAt = now
      account.lastError = error
      account.revision += 1
      account.updatedAt = now
      return toPublicAccount(account)
    })
  }

  async updateAccountRuntime(
    id: string,
    input: UpdateAccountRuntimeInput,
    options: AccountWriteOptions = {}
  ): Promise<PublicAccount> {
    if (!ACCOUNT_STATUSES.includes(input.status)) {
      throw invalidRequest("status is invalid", "invalid_account_status", "status")
    }
    if (input.markLogin !== undefined && typeof input.markLogin !== "boolean") {
      throw invalidRequest("markLogin must be a boolean", "invalid_account_status", "markLogin")
    }
    const cookie = optionalCookie(input.cookie)
    const error = this.errorMessage(input.lastError ?? null)
    return this.#repository.transact((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id)
      if (!account) throw notFound()
      this.assertRevision(account, options.expectedRevision)
      if (cookie !== undefined) account.cookie = cookie
      if (input.status === "ready" && !account.cookie) {
        throw conflict("An account without a session cookie cannot be ready", "account_session_missing")
      }
      const now = this.timestamp()
      account.status = input.status
      account.lastCheckedAt = now
      account.lastError = error
      if (input.markLogin) account.lastLoginAt = now
      account.revision += 1
      account.updatedAt = now
      return toPublicAccount(account)
    })
  }

  private timestamp(): string {
    const value = new Date(this.#now()).toISOString()
    return value
  }

  private assertRevision(account: StoredAccount, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && expectedRevision !== account.revision) {
      throw conflict("The account changed while the operation was in progress", "account_revision_conflict")
    }
  }

  private resetSessionMetadata(account: StoredAccount): void {
    account.status = "unknown"
    account.lastLoginAt = null
    account.lastCheckedAt = null
    account.lastError = null
  }

  private errorMessage(value: string | null): string | null {
    if (value === null) return null
    if (typeof value !== "string" || value.length > 240) {
      throw invalidRequest("errorMessage must be 240 characters or fewer", "invalid_account_status", "errorMessage")
    }
    return value || null
  }
}
