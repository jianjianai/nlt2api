import { ApiError } from "../shared/errors"
import {
  MAX_PORTAL_JSON_BYTES,
  PORTAL_CHAT_TIMEOUT_MS,
  PORTAL_CONNECT_TIMEOUT_MS
} from "../shared/limits"
import { isJsonObject, type JsonObject } from "../shared/json"

export interface PortalCredentials {
  email: string
  password: string
}

export interface PortalSessionResult {
  ok: boolean
  status: number
  cookie?: string
  reason?: "expired" | "challenge" | "rate_limited" | "invalid_response" | "unreachable"
}

export interface PortalClientOptions {
  origin?: string
  modelCatalogUrl?: string
  fetch?: typeof fetch
  connectTimeoutMs?: number
  chatTimeoutMs?: number
  maximumJsonBytes?: number
}

export class PortalClient {
  private readonly origin: string
  private readonly modelCatalogUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly connectTimeoutMs: number
  private readonly chatTimeoutMs: number
  private readonly maximumJsonBytes: number

  constructor(options: PortalClientOptions = {}) {
    this.origin = normalizedOrigin(options.origin ?? process.env.NEURALWATT_PORTAL_ORIGIN ?? "https://portal.neuralwatt.com")
    this.modelCatalogUrl = new URL(
      options.modelCatalogUrl ?? process.env.NEURALWATT_MODEL_CATALOG_URL ?? "https://api.neuralwatt.com/v1/models"
    ).toString()
    this.fetchImpl = options.fetch ?? fetch
    this.connectTimeoutMs = options.connectTimeoutMs ?? PORTAL_CONNECT_TIMEOUT_MS
    this.chatTimeoutMs = options.chatTimeoutMs ?? PORTAL_CHAT_TIMEOUT_MS
    this.maximumJsonBytes = options.maximumJsonBytes ?? MAX_PORTAL_JSON_BYTES
  }

  async login(credentials: PortalCredentials, signal?: AbortSignal): Promise<PortalSessionResult> {
    const form = new URLSearchParams({ email: credentials.email, password: credentials.password })
    let response: Response
    try {
      response = await this.fetchImpl(new URL("/auth/login", this.origin), {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: form,
        signal: requestSignal(signal, this.connectTimeoutMs)
      })
    } catch (error) {
      if (isAbortError(error)) throw timeoutError(error)
      return { ok: false, status: 502, reason: "unreachable" }
    }

    const cookie = cookieHeader(getSetCookieValues(response.headers))
    await discardBody(response)
    if (!cookie) {
      if (response.status === 403) return { ok: false, status: 403, reason: "challenge" }
      if (response.status === 429) return { ok: false, status: 429, reason: "rate_limited" }
      return { ok: false, status: response.status || 401, reason: "expired" }
    }

    const checked = await this.checkSession(cookie, signal)
    return checked.ok ? { ...checked, cookie: mergeCookies(cookie, checked.cookie) } : checked
  }

  async checkSession(cookie: string, signal?: AbortSignal): Promise<PortalSessionResult> {
    if (!cookie.trim()) return { ok: false, status: 401, reason: "expired" }
    let response: Response
    try {
      response = await this.fetchImpl(new URL("/api/usage", this.origin), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json", cookie },
        signal: requestSignal(signal, this.connectTimeoutMs)
      })
    } catch (error) {
      if (isAbortError(error)) throw timeoutError(error)
      return { ok: false, status: 502, reason: "unreachable" }
    }

    const rotatedCookie = cookieHeader(getSetCookieValues(response.headers)) || undefined
    if (response.status === 401) {
      await discardBody(response)
      return { ok: false, status: 401, reason: "expired" }
    }
    if (response.status === 403 || isRedirect(response.status)) {
      await discardBody(response)
      return { ok: false, status: response.status, reason: "challenge" }
    }
    if (response.status === 429) {
      await discardBody(response)
      return { ok: false, status: 429, reason: "rate_limited" }
    }
    if (!response.ok || !isJsonContentType(response.headers.get("content-type"))) {
      await discardBody(response)
      return { ok: false, status: response.status || 502, reason: "invalid_response" }
    }

    try {
      const value = await readPortalJson(response, this.maximumJsonBytes)
      if (!isJsonObject(value) || typeof value.rate_limited !== "boolean") {
        return { ok: false, status: 502, reason: "invalid_response" }
      }
      return { ok: true, status: response.status, ...(rotatedCookie ? { cookie: rotatedCookie } : {}) }
    } catch (error) {
      if (error instanceof ApiError && error.code === "upstream_timeout") throw error
      return { ok: false, status: 502, reason: "invalid_response" }
    }
  }

  async chat(cookie: string, payload: JsonObject, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(new URL("/api/chat", this.origin), {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: payload.stream === true ? "text/event-stream" : "application/json",
          "content-type": "application/json",
          cookie
        },
        body: JSON.stringify(payload),
        signal: requestSignal(signal, this.chatTimeoutMs)
      })
    } catch (error) {
      if (isAbortError(error)) throw timeoutError(error)
      throw new ApiError("The NeuralWatt portal is unreachable", {
        status: 502,
        code: "upstream_unreachable",
        cause: error
      })
    }

    if (isRedirect(response.status)) {
      await discardBody(response)
      throw new ApiError("The NeuralWatt portal session has expired", {
        status: 401,
        code: "upstream_session_expired",
        type: "authentication_error"
      })
    }
    return responseWithMappedBodyErrors(response)
  }

  async modelCatalog(signal?: AbortSignal): Promise<{ body: JsonObject; scope: string | null }> {
    let response: Response
    try {
      response = await this.fetchImpl(this.modelCatalogUrl, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: requestSignal(signal, this.connectTimeoutMs)
      })
    } catch (error) {
      if (isAbortError(error)) throw timeoutError(error)
      throw new ApiError("The NeuralWatt model catalog is unreachable", {
        status: 502,
        code: "model_catalog_unreachable",
        cause: error
      })
    }
    if (!response.ok || !isJsonContentType(response.headers.get("content-type"))) {
      await discardBody(response)
      throw new ApiError("The NeuralWatt model catalog is unavailable", {
        status: 502,
        code: "model_catalog_unavailable"
      })
    }
    const value = await readPortalJson(response, this.maximumJsonBytes)
    if (!isJsonObject(value) || value.object !== "list" || !Array.isArray(value.data)) {
      throw new ApiError("The NeuralWatt model catalog returned an invalid response", {
        status: 502,
        code: "invalid_model_catalog"
      })
    }
    const headerScope = response.headers.get("x-models-scope")
    return { body: value, scope: headerScope ?? (typeof value.scope === "string" ? value.scope : null) }
  }
}

function normalizedOrigin(value: string): string {
  const url = new URL(value)
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TypeError("NEURALWATT_PORTAL_ORIGIN must use HTTPS unless it targets loopback")
  }
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString()
}

function requestSignal(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return outer ? AbortSignal.any([outer, timeout]) : timeout
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

function timeoutError(cause: unknown): ApiError {
  return new ApiError("The NeuralWatt portal request timed out", {
    status: 504,
    code: "upstream_timeout",
    cause
  })
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function isJsonContentType(value: string | null): boolean {
  return value?.toLowerCase().split(";", 1)[0]?.trim() === "application/json"
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The connection is already closed.
  }
}

export async function readPortalJson(response: Response, maximumBytes = MAX_PORTAL_JSON_BYTES): Promise<unknown> {
  if (!response.body) throw new TypeError("Response body is empty")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel("response_too_large")
        throw new ApiError("The NeuralWatt portal response exceeded the size limit", {
          status: 502,
          code: "upstream_response_too_large"
        })
      }
      chunks.push(next.value)
    }
  } catch (error) {
    if (isAbortError(error)) throw timeoutError(error)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new ApiError("The NeuralWatt portal returned malformed JSON", {
      status: 502,
      code: "invalid_upstream_json",
      cause: error
    })
  }
}

function responseWithMappedBodyErrors(response: Response): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          reader.releaseLock()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        try {
          reader.releaseLock()
        } catch {
          // The failed body may already have released its reader.
        }
        controller.error(isAbortError(error) ? timeoutError(error) : error)
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
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

function getSetCookieValues(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.()
  if (values && values.length > 0) return values
  const combined = headers.get("set-cookie")
  return combined ? splitSetCookie(combined) : []
}

function splitSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g)
}

function cookieHeader(values: string[]): string {
  return values
    .map((value) => value.split(";", 1)[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")
}

function mergeCookies(current: string, update?: string): string {
  const cookies = new Map<string, string>()
  for (const segment of `${current}; ${update ?? ""}`.split(";")) {
    const value = segment.trim()
    const separator = value.indexOf("=")
    if (separator > 0) cookies.set(value.slice(0, separator), value.slice(separator + 1))
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
}
