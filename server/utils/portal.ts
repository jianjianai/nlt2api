import { splitCookiesString } from "h3"
import { AccountAuthError, AppError } from "./errors"
import type { StoredAccount } from "./store"

const PORTAL_ORIGIN = process.env.NEURALWATT_PORTAL_ORIGIN || "https://portal.neuralwatt.com"
const LOGIN_URL = `${PORTAL_ORIGIN}/auth/login`
const CHAT_URL = `${PORTAL_ORIGIN}/api/chat`
const USAGE_URL = `${PORTAL_ORIGIN}/api/usage`

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
      return { ok: false, status: response.status, reason: "session_expired" }
    }

    return { ok: false, status: response.status, reason: "session_check_failed" }
  } catch {
    return { ok: false, status: 502, reason: "portal_unreachable" }
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
      return { ok: false, status: response.status, reason }
    }

    const session = await checkPortalSession(cookie)
    if (!session.ok) {
      return { ok: false, status: session.status, reason: session.reason }
    }

    return { ok: true, cookie, status: response.status }
  } catch {
    return { ok: false, status: 502, reason: "portal_unreachable" }
  }
}

export async function fetchPortalChat(cookie: string, payload: Record<string, unknown>): Promise<Response> {
  try {
    return await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        accept: payload.stream === true ? "text/event-stream" : "application/json",
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify(payload),
      signal: timeoutSignal(180_000)
    })
  } catch {
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
