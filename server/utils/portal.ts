import { splitCookiesString } from "h3"
import { AccountAuthError, AppError } from "./errors"
import { captureDebugResponse, type DebugTrace } from "./debug"
import type { StoredAccount } from "./store"

const PORTAL_ORIGIN = process.env.NEURALWATT_PORTAL_ORIGIN || "https://portal.neuralwatt.com"
const LOGIN_URL = `${PORTAL_ORIGIN}/auth/login`
const CHAT_URL = `${PORTAL_ORIGIN}/api/chat`
const USAGE_URL = `${PORTAL_ORIGIN}/api/usage`
const MODEL_CATALOG_URL = process.env.NEURALWATT_MODEL_CATALOG_URL || "https://api.neuralwatt.com/v1/models"

export interface SessionCheck {
  ok: boolean
  status: number
  reason?: string
}

export interface LoginResult {
  ok: boolean
  cookie?: string
  status: number
  reason?: string
}

export interface ModelCatalog {
  body: Record<string, unknown>
  scope: string | null
}

function getSetCookieValues(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  const values = withGetter.getSetCookie?.()
  if (values && values.length > 0) {
    return values
  }

  const combined = headers.get("set-cookie")
  return combined ? splitCookiesString(combined) : []
}

function cookieHeader(values: string[]): string {
  return values
    .map((value) => value.split(";", 1)[0]?.trim() || "")
    .filter(Boolean)
    .join("; ")
}

function timeoutSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(milliseconds)
}

export function isPortalTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true
  if (!(error instanceof Error)) return false
  return error.name === "TimeoutError" || /aborted due to timeout|timed out|timeout/i.test(error.message)
}

export async function checkPortalSession(cookie: string): Promise<SessionCheck> {
  if (!cookie.trim()) {
    return { ok: false, status: 401, reason: "missing_session" }
  }

  try {
    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers: { accept: "application/json", cookie },
      signal: timeoutSignal(20_000)
    })

    if (response.ok) {
      return { ok: true, status: response.status }
    }

    if (response.status === 401 || response.status === 403) {
      console.warn(`[portal] session check expired status=${response.status}`)
      return { ok: false, status: response.status, reason: "session_expired" }
    }

    console.warn(`[portal] session check failed status=${response.status}`)
    return { ok: false, status: response.status, reason: "session_check_failed" }
  } catch {
    console.warn("[portal] session check failed: portal unreachable")
    return { ok: false, status: 502, reason: "portal_unreachable" }
  }
}

export async function fetchPortalModelCatalog(): Promise<ModelCatalog> {
  try {
    const response = await fetch(MODEL_CATALOG_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: timeoutSignal(20_000)
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new AppError("The Neuralwatt model catalog is unavailable", 502, "model_catalog_unavailable")
    }

    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new AppError("The Neuralwatt model catalog returned invalid JSON", 502, "invalid_model_catalog")
    }
    const catalog = body as Record<string, unknown>
    if (catalog.object !== "list" || !Array.isArray(catalog.data)) {
      throw new AppError("The Neuralwatt model catalog returned an invalid response", 502, "invalid_model_catalog")
    }

    return {
      body: catalog,
      scope: response.headers.get("x-models-scope") ?? (typeof catalog.scope === "string" ? catalog.scope : null)
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    console.error(`[portal] model catalog request failed: ${error instanceof Error ? error.message : "unknown"}`)
    throw new AppError("The Neuralwatt model catalog is unreachable", 502, "model_catalog_unavailable")
  }
}

export async function loginToPortal(account: Pick<StoredAccount, "email" | "password">): Promise<LoginResult> {
  if (!account.email || !account.password) {
    return { ok: false, status: 401, reason: "missing_credentials" }
  }

  try {
    const form = new URLSearchParams({ email: account.email, password: account.password })
    const response = await fetch(LOGIN_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: form,
      signal: timeoutSignal(30_000)
    })
    const cookie = cookieHeader(getSetCookieValues(response.headers))

    if (!cookie) {
      const reason = response.status === 403 || response.status === 429 ? "manual_cookie_required" : "invalid_credentials"
      console.warn(`[portal] login failed email=${account.email} status=${response.status} reason=${reason}`)
      return { ok: false, status: response.status, reason }
    }

    const session = await checkPortalSession(cookie)
    if (!session.ok) {
      console.warn(`[portal] post-login session check failed email=${account.email} status=${session.status} reason=${session.reason}`)
      return { ok: false, status: session.status, reason: session.reason }
    }

    console.info(`[portal] login ok email=${account.email}`)
    return { ok: true, cookie, status: response.status }
  } catch {
    console.warn(`[portal] login failed email=${account.email}: portal unreachable`)
    return { ok: false, status: 502, reason: "portal_unreachable" }
  }
}

export async function fetchPortalChat(cookie: string, payload: Record<string, unknown>, trace?: DebugTrace, attempt = 1): Promise<Response> {
  const body = JSON.stringify(payload)
  await trace?.recordText("upstream-request", body, { attempt, stream: payload.stream === true })
  try {
    const response = await captureDebugResponse(trace, "upstream-response", await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        accept: payload.stream === true ? "text/event-stream" : "application/json",
        "content-type": "application/json",
        cookie
      },
      body,
      signal: timeoutSignal(180_000)
    }), { attempt, stream: payload.stream === true })
    if (!response.ok) {
      console.error(`[portal] chat rejected status=${response.status} stream=${String(payload.stream)}`)
    }
    return response
  } catch (error) {
    if (isPortalTimeoutError(error)) {
      await trace?.recordJson("upstream-response", { error: "upstream_timeout" }, { attempt, stream: payload.stream === true })
      console.error("[portal] chat request timed out")
      throw new AppError("The Neuralwatt portal chat request timed out", 504, "upstream_timeout")
    }
    await trace?.recordJson("upstream-response", { error: "portal_unreachable" }, { attempt, stream: payload.stream === true })
    console.error(`[portal] chat request failed: portal unreachable (${error instanceof Error ? error.message : "unknown"})`)
    throw new AppError("The Neuralwatt portal is unreachable", 502, "portal_unreachable")
  }
}

export async function ensurePortalLogin(account: StoredAccount): Promise<string> {
  const result = await loginToPortal(account)
  if (!result.ok || !result.cookie) {
    const status = result.reason === "manual_cookie_required" ? "The portal requires a manually supplied Cookie header" : "Portal login failed"
    throw new AccountAuthError(status, result.reason || "account_login_failed")
  }
  return result.cookie
}
