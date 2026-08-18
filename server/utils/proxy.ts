import { AccountAuthError, AppError } from "./errors"
import type { DebugTrace } from "./debug"
import { validateChatRequest, type ValidatedChatRequest } from "./openai"
import { checkPortalSession, ensurePortalLogin, fetchPortalChat } from "./portal"
import { completionFromAgentResult, completionToModelOutput, createOpenAIStream, readJsonCompletion, readSseCompletion } from "./response"
import { runAgentLoop, type AgentMessage, type AgentModelOutput } from "./agent-loop"
import { getAccount, getEnabledAccounts, getGenerationDefaults, recordAccountLogin, recordAccountStatus, type StoredAccount } from "./store"

type JsonObject = Record<string, unknown>

export type ProxyResult =
  | { kind: "json"; body: JsonObject }
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
  try { await response.body?.cancel() } catch { /* response discarded */ }
}

async function refreshAccount(account: StoredAccount): Promise<string> {
  const cookie = await ensurePortalLogin(account)
  await recordAccountLogin(account.id, cookie)
  return cookie
}

async function prepareCookie(account: StoredAccount): Promise<string> {
  if (account.cookie) {
    const checked = account.lastCheckedAt ? Date.parse(account.lastCheckedAt) : 0
    if (account.status === "ready" && Number.isFinite(checked) && Date.now() - checked < 60_000) return account.cookie
    const session = await checkPortalSession(account.cookie)
    if (session.ok) {
      await recordAccountStatus(account.id, "ready", null)
      return account.cookie
    }
    if (session.reason !== "session_expired" && session.status !== 401 && session.status !== 403) return account.cookie
  }
  return refreshAccount(account)
}

async function fetchWithAuth(account: StoredAccount, payload: JsonObject, trace: DebugTrace | undefined, attempt: number): Promise<Response> {
  let response = await fetchPortalChat(await prepareCookie(account), payload, trace, attempt)
  if (isAuthStatus(response.status)) {
    await discardResponse(response)
    response = await fetchPortalChat(await refreshAccount(account), payload, trace, attempt + 1)
  }
  if (isAuthStatus(response.status)) {
    await discardResponse(response)
    throw new AccountAuthError("The cached account session is not valid", "session_expired")
  }
  return response
}

function baseMessages(payload: JsonObject): AgentMessage[] {
  if (!Array.isArray(payload.messages)) return []
  return payload.messages.filter((value): value is AgentMessage => typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as JsonObject).role === "string").map((value) => ({ ...value }))
}

async function proxyForAccount(account: StoredAccount, request: ValidatedChatRequest, trace: DebugTrace | undefined, nextAttempt: () => number): Promise<ProxyResult> {
  console.info("[proxy] agent request account=" + account.label + " model=" + request.model + " stream=" + String(request.stream) + " tools=" + String(Boolean(request.toolPlan)))
  const result = await runAgentLoop({
    baseMessages: baseMessages(request.portalPayload),
    toolPlan: request.toolPlan,
    requestModel: async (messages: AgentMessage[]): Promise<AgentModelOutput> => {
      const payload = { ...request.portalPayload, messages, stream: request.stream }
      const response = await fetchWithAuth(account, payload, trace, nextAttempt())
      if (!response.ok) {
        const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status
        await discardResponse(response)
        throw new AppError("Neuralwatt rejected the request with HTTP " + response.status, status, "upstream_http_error")
      }
      if (request.stream) return readSseCompletion(response.body)
      return completionToModelOutput(await readJsonCompletion(response), request.model)
    }
  })
  if (request.stream) return { kind: "stream", body: createOpenAIStream(result, request.model, request.includeUsage) }
  return { kind: "json", body: completionFromAgentResult(result, request.model) }
}

export async function handleChatRequest(input: unknown, trace?: DebugTrace): Promise<ProxyResult> {
  const request = validateChatRequest(input, await getGenerationDefaults())
  const accounts = orderedAccounts(await getEnabledAccounts())
  if (accounts.length === 0) throw new AppError("No enabled Neuralwatt accounts are configured", 503, "no_enabled_accounts")
  let authFailures = 0
  let attempt = 0
  for (const account of accounts) {
    try {
      return await proxyForAccount(account, request, trace, () => ++attempt)
    } catch (error) {
      if (error instanceof AccountAuthError) {
        authFailures += 1
        continue
      }
      throw error
    }
  }
  throw new AppError("All " + authFailures + " enabled account sessions are unavailable", 401, "all_accounts_unauthorized", undefined, "authentication_error")
}

export async function checkAccount(id: string): Promise<{ ok: boolean; status: number; reason?: string }> {
  const account = await getAccount(id)
  const result = await checkPortalSession(account.cookie)
  await recordAccountStatus(id, result.ok ? "ready" : result.reason === "session_expired" ? "expired" : "login_failed", result.ok ? null : result.reason || "session_check_failed")
  return result
}
