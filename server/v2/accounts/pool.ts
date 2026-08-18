import { ApiError } from "../shared/errors"
import { MAX_PORTAL_JSON_BYTES } from "../shared/limits"
import { isJsonObject, type JsonObject } from "../shared/json"
import {
  readPortalJson,
  type PortalChatTrace,
  type PortalCredentials,
  type PortalSessionResult
} from "../portal/client"
import { parseSseJson, SseDecoder } from "../portal/sse"
import type { AccountService } from "../state/accounts"
import type { StoredAccount } from "../state/schema"

export interface AccountPortalClient {
  login(credentials: PortalCredentials, signal?: AbortSignal): Promise<PortalSessionResult>
  checkSession(cookie: string, signal?: AbortSignal): Promise<PortalSessionResult>
  chat(cookie: string, payload: JsonObject, signal?: AbortSignal, trace?: PortalChatTrace): Promise<Response>
}

export type PortalChatExchange =
  | { kind: "json"; value: JsonObject; accountId: string }
  | { kind: "stream"; response: Response; accountId: string }

export interface OpenPortalChatOptions {
  signal?: AbortSignal
  maximumJsonBytes?: number
  requestLogId?: string
}

type AttemptFailure = "authentication" | "rate_limit"

class RetryableAccountFailure extends Error {
  readonly kind: AttemptFailure

  constructor(kind: AttemptFailure, message: string) {
    super(message)
    this.name = "RetryableAccountFailure"
    this.kind = kind
  }
}

const AUTH_MESSAGE = /unauthor|authentication|session|login|cookie|csrf|token|sign[ -]?in/i
const MAX_SSE_PRELUDE_BYTES = 64 * 1024

export class AccountPool {
  private readonly accounts: AccountService
  private readonly portal: AccountPortalClient
  private readonly loginFlights = new Map<string, Promise<string>>()
  private cursor = 0

  constructor(accounts: AccountService, portal: AccountPortalClient) {
    this.accounts = accounts
    this.portal = portal
  }

  async openChat(payload: JsonObject, options: OpenPortalChatOptions = {}): Promise<PortalChatExchange> {
    const candidates = this.rotate(await this.accounts.listEnabledAccounts())
    if (candidates.length === 0) {
      throw new ApiError("No enabled NeuralWatt accounts are configured", {
        status: 503,
        code: "no_enabled_accounts"
      })
    }

    let authenticationFailures = 0
    let rateLimitFailures = 0
    for (const candidate of candidates) {
      try {
        return await this.openForAccount(candidate, payload, options)
      } catch (error) {
        if (!(error instanceof RetryableAccountFailure)) throw error
        if (error.kind === "authentication") authenticationFailures += 1
        else rateLimitFailures += 1
      }
    }

    if (rateLimitFailures > 0 && authenticationFailures === 0) {
      throw new ApiError("All enabled NeuralWatt accounts are rate limited", {
        status: 429,
        code: "all_accounts_rate_limited",
        type: "rate_limit_error"
      })
    }
    throw new ApiError("All enabled NeuralWatt account sessions are unavailable", {
      status: 401,
      code: "all_accounts_unauthorized",
      type: "authentication_error"
    })
  }

  async loginAccount(id: string, signal?: AbortSignal): Promise<void> {
    const account = await this.accounts.getAccountRecord(id)
    await this.login(account, signal, true)
  }

  async checkAccount(id: string, signal?: AbortSignal): Promise<PortalSessionResult> {
    const account = await this.accounts.getAccountRecord(id)
    const result = await this.portal.checkSession(account.cookie, signal)
    if (result.ok) {
      await this.safeRuntimeUpdate(account, {
        status: "ready",
        ...(result.cookie ? { cookie: result.cookie } : {}),
        lastError: null
      })
    } else {
      const status = result.reason === "challenge" ? "manual_cookie_required"
        : result.reason === "expired" ? "expired"
          : "temporarily_unavailable"
      await this.safeRuntimeUpdate(account, { status, lastError: result.reason ?? "session_check_failed" })
    }
    return result
  }

  private rotate(accounts: StoredAccount[]): StoredAccount[] {
    if (accounts.length < 2) return accounts
    const start = this.cursor % accounts.length
    this.cursor = (this.cursor + 1) % accounts.length
    return [...accounts.slice(start), ...accounts.slice(0, start)]
  }

  private async openForAccount(
    initial: StoredAccount,
    payload: JsonObject,
    options: OpenPortalChatOptions
  ): Promise<PortalChatExchange> {
    let account = initial
    let refreshed = false
    while (true) {
      const cookie = account.cookie || await this.login(account, options.signal, false)
      const trace = options.requestLogId ? { requestId: options.requestLogId, accountId: account.id } : undefined
      const response = await this.portal.chat(cookie, payload, options.signal, trace)
      if (response.status === 401) {
        await cancelResponse(response)
        if (refreshed) {
          await this.markUnavailable(account, "expired", "session_expired")
          throw new RetryableAccountFailure("authentication", "session expired")
        }
        account = await this.accounts.getAccountRecord(account.id)
        await this.login(account, options.signal, true)
        account = await this.accounts.getAccountRecord(account.id)
        refreshed = true
        continue
      }
      if (response.status === 429) {
        await cancelResponse(response)
        await this.markUnavailable(account, "temporarily_unavailable", "rate_limited")
        throw new RetryableAccountFailure("rate_limit", "account rate limited")
      }
      if (response.status === 403) {
        const session = await this.portal.checkSession(cookie, options.signal)
        if (!session.ok && session.reason === "expired") {
          await cancelResponse(response)
          if (refreshed) {
            await this.markUnavailable(account, "expired", "session_expired")
            throw new RetryableAccountFailure("authentication", "session expired")
          }
          account = await this.accounts.getAccountRecord(account.id)
          await this.login(account, options.signal, true)
          account = await this.accounts.getAccountRecord(account.id)
          refreshed = true
          continue
        }
      }
      if (!response.ok) throw await upstreamHttpError(response)

      if (payload.stream === true) {
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
        if (!contentType.startsWith("text/event-stream")) {
          await cancelResponse(response)
          throw new ApiError("The NeuralWatt portal returned a non-SSE response", {
            status: 502,
            code: "invalid_upstream_content_type"
          })
        }
        const preflight = await preflightSse(response)
        if (preflight.error) {
          if (preflight.auth && !refreshed) {
            account = await this.accounts.getAccountRecord(account.id)
            await this.login(account, options.signal, true)
            account = await this.accounts.getAccountRecord(account.id)
            refreshed = true
            continue
          }
          if (preflight.auth) {
            await this.markUnavailable(account, "expired", "session_expired")
            throw new RetryableAccountFailure("authentication", "embedded authentication error")
          }
          throw new ApiError(preflight.error, { status: 502, code: "upstream_stream_error" })
        }
        if (!preflight.response) {
          throw new ApiError("The NeuralWatt portal stream could not be replayed", {
            status: 502,
            code: "invalid_upstream_stream"
          })
        }
        await this.markReady(account)
        return { kind: "stream", response: preflight.response, accountId: account.id }
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
      if (!contentType.startsWith("application/json")) {
        await cancelResponse(response)
        throw new ApiError("The NeuralWatt portal returned a non-JSON response", {
          status: 502,
          code: "invalid_upstream_content_type"
        })
      }
      const value = await readPortalJson(response, options.maximumJsonBytes ?? MAX_PORTAL_JSON_BYTES)
      if (!isJsonObject(value)) {
        throw new ApiError("The NeuralWatt portal returned invalid JSON", {
          status: 502,
          code: "invalid_upstream_json"
        })
      }
      const embeddedError = upstreamErrorMessage(value.error)
      if (embeddedError) {
        if (AUTH_MESSAGE.test(embeddedError) && !refreshed) {
          account = await this.accounts.getAccountRecord(account.id)
          await this.login(account, options.signal, true)
          account = await this.accounts.getAccountRecord(account.id)
          refreshed = true
          continue
        }
        if (AUTH_MESSAGE.test(embeddedError)) {
          await this.markUnavailable(account, "expired", "session_expired")
          throw new RetryableAccountFailure("authentication", "embedded authentication error")
        }
        throw new ApiError(embeddedError, { status: 502, code: "upstream_error" })
      }
      await this.markReady(account)
      return { kind: "json", value, accountId: account.id }
    }
  }

  private login(account: StoredAccount, signal: AbortSignal | undefined, force: boolean): Promise<string> {
    const existing = this.loginFlights.get(account.id)
    if (existing) return waitForFlight(existing, signal)
    // The shared login has its own bounded portal timeout. A caller's abort may
    // stop that caller from waiting, but must not cancel every other waiter.
    const flight = this.performLogin(account, undefined, force).finally(() => {
      if (this.loginFlights.get(account.id) === flight) this.loginFlights.delete(account.id)
    })
    this.loginFlights.set(account.id, flight)
    return waitForFlight(flight, signal)
  }

  private async performLogin(account: StoredAccount, signal: AbortSignal | undefined, force: boolean): Promise<string> {
    const current = await this.accounts.getAccountRecord(account.id)
    if (!force && current.cookie) return current.cookie
    const result = await this.portal.login({ email: current.email, password: current.password }, signal)
    if (!result.ok || !result.cookie) {
      const status = result.reason === "challenge" ? "manual_cookie_required"
        : result.reason === "expired" ? "login_failed"
          : "temporarily_unavailable"
      await this.safeRuntimeUpdate(current, { status, cookie: null, lastError: result.reason ?? "login_failed" })
      throw new RetryableAccountFailure(
        result.reason === "rate_limited" ? "rate_limit" : "authentication",
        result.reason ?? "login failed"
      )
    }
    await this.accounts.updateAccountRuntime(current.id, {
      status: "ready",
      cookie: result.cookie,
      lastError: null,
      markLogin: true
    }, { expectedRevision: current.revision })
    return result.cookie
  }

  private async markReady(account: StoredAccount): Promise<void> {
    const current = await this.accounts.getAccountRecord(account.id)
    if (current.status === "ready" && current.cookie) return
    await this.safeRuntimeUpdate(current, { status: "ready", lastError: null })
  }

  private async markUnavailable(
    account: StoredAccount,
    status: "expired" | "temporarily_unavailable",
    reason: string
  ): Promise<void> {
    const current = await this.accounts.getAccountRecord(account.id)
    await this.safeRuntimeUpdate(current, { status, lastError: reason })
  }

  private async safeRuntimeUpdate(
    account: StoredAccount,
    input: Parameters<AccountService["updateAccountRuntime"]>[1]
  ): Promise<void> {
    try {
      await this.accounts.updateAccountRuntime(account.id, input, { expectedRevision: account.revision })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "account_revision_conflict") throw error
    }
  }
}

function waitForFlight<T>(flight: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return flight
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = (): void => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    void flight.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError")
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already closed.
  }
}

async function upstreamHttpError(response: Response): Promise<ApiError> {
  const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status
  await cancelResponse(response)
  return new ApiError(`NeuralWatt rejected the request with HTTP ${response.status}`, {
    status,
    code: response.status === 429 ? "upstream_rate_limited" : "upstream_http_error"
  })
}

function upstreamErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (isJsonObject(value) && typeof value.message === "string" && value.message.trim()) return value.message.trim()
  return undefined
}

async function preflightSse(response: Response): Promise<
  | { response: Response; error?: undefined; auth?: undefined }
  | { response?: undefined; error: string; auth: boolean }
> {
  if (!response.body) {
    return { error: "The NeuralWatt portal returned an empty stream", auth: false }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const sse = new SseDecoder()
  const prefix: Uint8Array[] = []
  let size = 0
  try {
    while (size <= MAX_SSE_PRELUDE_BYTES) {
      const next = await reader.read()
      if (next.done) {
        reader.releaseLock()
        return { error: "The NeuralWatt portal ended the stream before its first event", auth: false }
      }
      prefix.push(next.value)
      size += next.value.byteLength
      const events = sse.push(decoder.decode(next.value, { stream: true }))
      if (events.length === 0) continue
      const parsed = parseSseJson(events[0].data)
      if (parsed !== "[DONE]") {
        const message = upstreamErrorMessage(parsed.error)
        if (message) {
          await reader.cancel("upstream_error")
          reader.releaseLock()
          return { error: message, auth: AUTH_MESSAGE.test(message) }
        }
      }
      const body = replayStream(prefix, reader)
      return {
        response: new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        })
      }
    }
    await reader.cancel("sse_prelude_too_large")
    reader.releaseLock()
    return { error: "The NeuralWatt portal did not produce an SSE data event within the prelude limit", auth: false }
  } catch (error) {
    try {
      await reader.cancel("invalid_upstream_sse")
    } catch {
      // Preserve the parser or transport error.
    }
    try {
      reader.releaseLock()
    } catch {
      // The lock may already have been released by a terminal branch.
    }
    if (error instanceof ApiError) throw error
    throw new ApiError("The NeuralWatt portal stream could not be preflighted", {
      status: 502,
      code: "invalid_upstream_stream",
      cause: error
    })
  }
}

function replayStream(prefix: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefix.length) {
        controller.enqueue(prefix[index])
        index += 1
        return
      }
      try {
        const next = await reader.read()
        if (next.done) {
          reader.releaseLock()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        reader.releaseLock()
      }
    }
  })
}
