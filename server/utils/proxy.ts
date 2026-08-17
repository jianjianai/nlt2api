import { AccountAuthError, AppError } from "./errors"
import { validateChatRequest, type ValidatedChatRequest } from "./openai"
import { checkPortalSession, ensurePortalLogin, fetchPortalChat } from "./portal"
import {
  createSseRelay,
  createToolSseRelay,
  normalizeCompletionWithLengthContinuation,
  normalizeToolCompletionWithRetry,
  prepareSse,
  type OutputLengthContinuation,
  type PreparedSse,
  type ToolActionRetry,
  type UpstreamStreamError
} from "./response"
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
    console.warn(`[proxy] portal returned ${response.status} for account=${account.label}; refreshing session`)
    await discardResponse(response)
    cookie = await refreshAccount(account)
    response = await fetchPortalChat(cookie, request.portalPayload)
  }

  if (isAuthStatus(response.status)) {
    console.error(`[proxy] account=${account.label} session still invalid after refresh; aborting request`)
    await discardResponse(response)
    throw new AccountAuthError("The cached account session is not valid", "session_expired")
  }

  return response
}

async function preparePortalSse(account: StoredAccount, request: ValidatedChatRequest): Promise<PreparedSse> {
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
    console.error(`[proxy] portal rejected streaming request account=${account.label} status=${response.status}`)
    await discardResponse(response)
    throw new AppError(`Neuralwatt rejected the request with HTTP ${response.status}`, status, "upstream_http_error", undefined, status === 429 ? "rate_limit_error" : "server_error")
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
      console.error(`[proxy] portal stream auth error account=${account.label} message=${streamError.message}`)
      await recordAccountStatus(account.id, "expired", streamError.message)
      throw new AccountAuthError("The upstream reported an expired session", "session_expired")
    }
    console.error(`[proxy] portal stream error account=${account.label} message=${streamError.message}`)
    throw new AppError(streamError.message, 502, "upstream_stream_error")
  }

  return prepared
}

type ReplayableContinuation = Pick<OutputLengthContinuation, "reasoning" | "content" | "nudge">

export function createContinuationPayloadBuilder(portalPayload: Record<string, unknown>): (continuation: ReplayableContinuation) => Record<string, unknown> {
  const messages = Array.isArray(portalPayload.messages) ? [...portalPayload.messages] : []
  return (continuation) => {
    // Preserve every prior assistant -> user retry pair verbatim. The next
    // upstream request then extends the preceding one, enabling prefix caching.
    if (continuation.content || continuation.reasoning) {
      messages.push({
        role: "assistant",
        ...(continuation.reasoning ? { reasoning: continuation.reasoning } : {}),
        content: continuation.content || null
      })
    }
    messages.push({ role: "user", content: continuation.nudge })
    return { ...portalPayload, messages: [...messages] }
  }
}

async function proxyForAccount(account: StoredAccount, request: ValidatedChatRequest): Promise<ProxyResult> {
  console.info(`[proxy] chat request account=${account.label} model=${request.model} stream=${request.stream} tools=${request.toolPlan ? "yes" : "no"} max_tokens=${request.portalPayload.max_tokens ?? "default"}`)
  const continuationPayload = createContinuationPayloadBuilder(request.portalPayload)
  const responseFormat = request.portalPayload.response_format
  const isJsonObjectResponse = typeof responseFormat === "object"
    && responseFormat !== null
    && !Array.isArray(responseFormat)
    && (responseFormat as Record<string, unknown>).type === "json_object"

  if (!request.stream) {
    const fetchJson = async (portalPayload: Record<string, unknown>): Promise<unknown> => {
      let response: Response
      try {
        response = await fetchWithAuthRecovery(account, { ...request, portalPayload })
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

      try {
        return await response.json()
      } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError("The upstream returned invalid JSON", 502, "invalid_upstream_json")
      }
    }

    const value = await fetchJson(request.portalPayload)
    if (!request.toolPlan) {
      const outputRefetch = isJsonObjectResponse
        ? undefined
        : async (continuation: OutputLengthContinuation): Promise<unknown> => {
            console.warn(`[proxy] output continuation account=${account.label} model=${request.model} preserved reasoning_chars=${continuation.reasoning.length} content_chars=${continuation.content.length}`)
            return fetchJson(continuationPayload(continuation))
          }
      return {
        kind: "json",
        body: await normalizeCompletionWithLengthContinuation(value, request.model, outputRefetch)
      }
    }
    const refetch = async (retry: ToolActionRetry): Promise<unknown> => {
      console.warn(`[proxy] tool action retry cause=${retry.cause} account=${account.label} model=${request.model} preserved reasoning_chars=${retry.reasoning.length} content_chars=${retry.content.length}`)
      return fetchJson(continuationPayload(retry))
    }
    return {
      kind: "json",
      body: await normalizeToolCompletionWithRetry(value, request.model, request.toolPlan, refetch)
    }
  }

  const prepared = await preparePortalSse(account, request)
  if (request.toolPlan) {
    const refetch = async (retry: ToolActionRetry): Promise<PreparedSse> => {
      console.warn(`[proxy] tool action retry cause=${retry.cause} account=${account.label} model=${request.model} preserved reasoning_chars=${retry.reasoning.length} content_chars=${retry.content.length}`)
      return preparePortalSse(account, { ...request, portalPayload: continuationPayload(retry) })
    }
    return {
      kind: "stream",
      body: createToolSseRelay(prepared, request.model, request.includeUsage, request.toolPlan, refetch)
    }
  }

  const outputRefetch = isJsonObjectResponse
    ? undefined
    : async (continuation: OutputLengthContinuation): Promise<PreparedSse> => {
        console.warn(`[proxy] output continuation account=${account.label} model=${request.model} preserved reasoning_chars=${continuation.reasoning.length} content_chars=${continuation.content.length}`)
        return preparePortalSse(account, { ...request, portalPayload: continuationPayload(continuation) })
      }
  return {
    kind: "stream",
    body: createSseRelay(prepared, request.model, request.includeUsage, outputRefetch)
  }
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

  console.error(`[proxy] all ${authFailures} enabled account session(s) unavailable`)
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
