import { randomBytes, timingSafeEqual } from "node:crypto"
import { resolve } from "node:path"
import { AccountPool } from "./accounts/pool"
import { ChatService } from "./chat/service"
import { PortalClient } from "./portal/client"
import { AdminSecurityService } from "./security/admin-security"
import { InferenceApiKeyService } from "./security/inference-api-keys"
import { AccountService } from "./state/accounts"
import { V2StateRepository } from "./state/file-repository"
import { SettingsService } from "./state/settings"

export interface RuntimeServices {
  repository: V2StateRepository
  accounts: AccountService
  settings: SettingsService
  inferenceKeys: InferenceApiKeyService
  adminSecurity: AdminSecurityService
  portal: PortalClient
  accountPool: AccountPool
  chat: ChatService
  bootstrap: {
    configured: boolean
    verify(token: unknown): boolean
  }
}

let runtimePromise: Promise<RuntimeServices> | undefined

export function getRuntime(): Promise<RuntimeServices> {
  runtimePromise ??= createRuntime()
  return runtimePromise
}

async function createRuntime(): Promise<RuntimeServices> {
  const dataFile = resolve(
    process.env.NEURALWATT_DATA_FILE ?? resolve(process.cwd(), ".data", "neuralwatt-accounts.yaml")
  )
  const repository = await V2StateRepository.open(dataFile)
  const accounts = new AccountService(repository)
  const settings = new SettingsService(repository)
  const inferenceKeys = new InferenceApiKeyService(repository)
  const bootstrapToken = process.env.NEURALWATT_BOOTSTRAP_TOKEN?.trim()
    || randomBytes(32).toString("base64url")
  const bootstrapConfigured = Boolean(process.env.NEURALWATT_BOOTSTRAP_TOKEN?.trim())
  const bootstrap = {
    configured: bootstrapConfigured,
    verify(token: unknown): boolean {
      if (typeof token !== "string" || token.length !== bootstrapToken.length) return false
      return timingSafeEqual(Buffer.from(token), Buffer.from(bootstrapToken))
    }
  }
  const adminSecurity = new AdminSecurityService(repository, { canInitializePassword: () => true })
  if (!await adminSecurity.hasPassword() && !bootstrapConfigured) {
    console.info(`[bootstrap] Administrator setup token: ${bootstrapToken}`)
  }
  const portal = new PortalClient()
  const accountPool = new AccountPool(accounts, portal)
  const chat = new ChatService(accountPool, settings)
  return {
    repository,
    accounts,
    settings,
    inferenceKeys,
    adminSecurity,
    portal,
    accountPool,
    chat,
    bootstrap
  }
}

export function resetRuntimeForTests(): void {
  runtimePromise = undefined
}
