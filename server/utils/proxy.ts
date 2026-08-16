import { AccountAuthError, AppError } from "./errors"
import { validateChatRequest, type ValidatedChatRequest } from "./openai"
import { checkPortalSession, ensurePortalLogin, fetchPortalChat } from "./portal"
import { createSseRelay, normalizeCompletion, prepareSse, type UpstreamStreamError } from "./response"
import {
  getAccount,
  getEnabledAccounts,
  recordAccountLogin,
  recordAccountStatus,
  type StoredAccount
} from "./store"

export type ProxyResult =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "stream"; body: ReadableStream<Uint8Array> }

let roundRobinCursor = 0

function orderedAccounts(accounts: StoredAccount[]): StoredAccount[] {
  if (accounts.length <= 1) return accounts
  const start = roundRobinCursor % accounts.length
  roundRobinCursor = (roundRobinCursor + 1) % accounts.length
  return [...accounts.slice(start), ...accounts.slice(0, start)]
}

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already being discarded.
  }
}

async function refreshAccount(account: StoredAccount): Promise<string> {
  const cookie = await ensurePortalLogin(account)
  await recordAccountLogin(account.id, cookie)
  return cookie
}

async function prepareAccountCookie(account: StoredAccount): Promise<string> {
  if (account.cookie) {
    const lastChecked = account.lastCheckedAt ? Date.parse(account.lastCheckedAt) : 0
    const checkIsFresh = account.status === "ready" && Number.isFinite(lastChecked) && Date.now() - lastChecked < 60_000
    if (checkIsFresh) return account.cookie

    const session = await checkPortalSession(account.cookie)
    if (session.ok) {
      await recordAccountStatus(account.id, "ready", null)
      return account.cookie
    }
    if (session.reason !== "session_expired" && session.status !== 401 && session.status !== 403) {
      return account.cookie
    }
    return refreshAccount(account)
  }
  return refreshAccount(account)
}

async function fetchWithAuthRecovery(account: StoredAccount, request: ValidatedChatRequest): Promise<Response> {
  let cookie = await prepareAccountCookie(account)
  let response = await fetchPortalChat(cookie, request.portalPayload)

  if (isAuthStatus(response.status)) {
    await discardResponse(response)
    cookie = await refreshAccount(account)
    response = await fetchPortalChat(cookie, request.portalPayload)
  }

  if (isAuthStatus(response.status)) {
    await discardResponse(response)
    throw new AccountAuthError("The cached account session is not valid", "session_expired")
  }

  return response
}

async function proxyForAccount(account: StoredAccount, request: ValidatedChatRequest): Promise<ProxyResult> {
  let response: Response
  try {
    response = await fetchWithAuthRecovery(account, request)
  } catch (error) {
    if (error instanceof AccountAuthError) {
      await recordAccountStatus(account.id, error.code === "manual_cookie_required" ? "manual_cookie_required" : "login_failed", error.message)
    }
    throw error
  }

  if (!response.ok) {
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status
    await discardResponse(response)
    throw new AppError(`Neuralwatt rejected the request with HTTP ${response.status}`, status, "upstream_http_error", undefined, status === 429 ? "rate_limit_error" : "server_error")
  }

  if (!request.stream) {
    try {
      const value: unknown = await response.json()
      return { kind: "json", body: normalizeCompletion(value, request.model) }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError("The upstream returned invalid JSON", 502, "invalid_upstream_json")
    }
  }

  const prepared = await prepareSse(response.body)
  if (prepared.firstError) {
    try {
      await prepared.reader.cancel()
    } catch {
      // The first SSE frame already contains the terminal error.
    } finally {
      prepared.reader.releaseLock()
    }
    const streamError: UpstreamStreamError = prepared.firstError
    if (streamError.isAuthError) {
      await recordAccountStatus(account.id, "expired", streamError.message)
      throw new AccountAuthError("The upstream reported an expired session", "session_expired")
    }
    throw new AppError(streamError.message, 502, "upstream_stream_error")
  }

  return { kind: "stream", body: createSseRelay(prepared, request.model, request.includeUsage) }
}

export async function handleChatRequest(input: unknown): Promise<ProxyResult> {
  const request = validateChatRequest(input)
  const accounts = orderedAccounts(await getEnabledAccounts())
  if (accounts.length === 0) {
    throw new AppError("No enabled Neuralwatt accounts are configured", 503, "no_enabled_accounts")
  }

  let authFailures = 0
  for (const account of accounts) {
    try {
      return await proxyForAccount(account, request)
    } catch (error) {
      if (error instanceof AccountAuthError) {
        authFailures += 1
        continue
      }
      throw error
    }
  }

  throw new AppError(
    `All ${authFailures} enabled account session${authFailures === 1 ? " is" : "s are"} unavailable`,
    401,
    "all_accounts_unauthorized",
    undefined,
    "authentication_error"
  )
}

export async function checkAccount(id: string): Promise<{ ok: boolean; status: number; reason?: string }> {
  const account = await getAccount(id)
  const result = await checkPortalSession(account.cookie)
  await recordAccountStatus(id, result.ok ? "ready" : result.reason === "session_expired" ? "expired" : "login_failed", result.ok ? null : result.reason || "session_check_failed")
  return result
}
