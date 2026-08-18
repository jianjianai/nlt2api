import { randomUUID } from "node:crypto"
import { asApiError, openAIErrorBody } from "../shared/errors"
import type { StateRepository } from "../state/file-repository"

export const REQUEST_LOG_MAX_RECORDS = 200
export const REQUEST_LOG_MAX_BODY_BYTES = 64 * 1024
export const REQUEST_LOG_MAX_TOTAL_BYTES = 8 * 1024 * 1024

const MAX_CAPTURED_STRING_CHARACTERS = 16 * 1024
const MAX_HEADER_COUNT = 128
const MAX_HEADER_VALUE_CHARACTERS = 4 * 1024
const MAX_COLLECTION_ITEMS = 512
const MAX_VALUE_DEPTH = 32
const REDACTED = "[REDACTED]"

export type RequestLogSource = "openai" | "admin_test"
export type RequestLogHeaders = Record<string, string>

export interface RequestLogError {
  name: string
  message: string
  code: string | null
  status: number | null
}

export interface RequestLogHttpRequest {
  method: string
  url: string
  headers: RequestLogHeaders
  body: unknown | null
  bodyTruncated: boolean
}

export interface RequestLogHttpResponse {
  status: number
  statusText: string
  headers: RequestLogHeaders
  body: unknown | null
  bodyTruncated: boolean
  outcome: "complete" | "cancelled"
}

export interface RequestLogUpstreamAttempt {
  id: string
  sequence: number
  accountId: string
  startedAt: string
  completedAt: string | null
  durationMs: number | null
  request: RequestLogHttpRequest
  response: RequestLogHttpResponse | null
  error: RequestLogError | null
}

export interface RequestLogRecord {
  id: string
  source: RequestLogSource
  startedAt: string
  completedAt: string | null
  durationMs: number | null
  client: {
    request: RequestLogHttpRequest
    result: RequestLogHttpResponse | null
    error: RequestLogError | null
  }
  upstream: RequestLogUpstreamAttempt[]
}

export interface BeginClientRequestInput {
  source: RequestLogSource
  method: string
  url: string
  headers?: HeaderSource
}

export interface BeginUpstreamRequestInput {
  accountId: string
  method: string
  url: string
  headers?: HeaderSource
  body?: unknown
}

export interface RequestLogSnapshot {
  enabled: boolean
  records: RequestLogRecord[]
  retention: {
    maxRecords: number
    maxBodyBytes: number
    maxTotalBytes: number
  }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>

interface CapturedBody {
  body: unknown | null
  truncated: boolean
}

interface StreamCapture {
  append(chunk: Uint8Array): void
  finish(): CapturedBody
}

interface SanitizationState {
  truncated: boolean
}

export interface RequestLogServiceOptions {
  now?: () => number
  createId?: () => string
  initialEnabled?: boolean
}

export class RequestLogService {
  readonly #repository: StateRepository
  readonly #now: () => number
  readonly #createId: () => string
  readonly #records: RequestLogRecord[] = []
  #enabled: boolean
  #totalBytes = 0

  constructor(repository: StateRepository, options: RequestLogServiceOptions = {}) {
    this.#repository = repository
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? randomUUID
    this.#enabled = options.initialEnabled === true
  }

  static async open(repository: StateRepository, options: RequestLogServiceOptions = {}): Promise<RequestLogService> {
    const state = await repository.snapshot()
    return new RequestLogService(repository, {
      ...options,
      initialEnabled: state.requestLogging?.enabled === true
    })
  }

  async snapshot(): Promise<RequestLogSnapshot> {
    return {
      enabled: this.#enabled,
      records: structuredClone([...this.#records].reverse()),
      retention: {
        maxRecords: REQUEST_LOG_MAX_RECORDS,
        maxBodyBytes: REQUEST_LOG_MAX_BODY_BYTES,
        maxTotalBytes: REQUEST_LOG_MAX_TOTAL_BYTES
      }
    }
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    const persisted = await this.#repository.transact((state) => {
      state.requestLogging = { enabled }
      return enabled
    })
    this.#enabled = persisted
    return persisted
  }

  clear(): number {
    const deletedCount = this.#records.length
    this.#records.length = 0
    this.#totalBytes = 0
    return deletedCount
  }

  async beginClientRequest(input: BeginClientRequestInput): Promise<string | undefined> {
    if (!this.#enabled) return undefined
    const timestamp = this.#now()
    const id = this.#createId()
    const record: RequestLogRecord = {
      id,
      source: input.source,
      startedAt: new Date(timestamp).toISOString(),
      completedAt: null,
      durationMs: null,
      client: {
        request: {
          method: sanitizeMethod(input.method),
          url: sanitizeUrl(input.url),
          headers: sanitizeHeaders(input.headers),
          body: null,
          bodyTruncated: false
        },
        result: null,
        error: null
      },
      upstream: []
    }
    this.#records.push(record)
    this.#recalculateAndTrim()
    return id
  }

  setClientBody(requestId: string | undefined, body: unknown): void {
    if (!requestId) return
    this.#update(requestId, (record) => {
      const captured = captureValue(body)
      record.client.request.body = captured.body
      record.client.request.bodyTruncated = captured.truncated
    })
  }

  finishClientJson(
    requestId: string | undefined,
    input: { status?: number; statusText?: string; headers?: HeaderSource; body: unknown }
  ): void {
    if (!requestId) return
    const captured = captureValue(input.body)
    this.#update(requestId, (record) => {
      if (record.completedAt) return
      record.client.result = {
        status: input.status ?? 200,
        statusText: sanitizeText(input.statusText ?? "OK"),
        headers: sanitizeHeaders(input.headers),
        body: captured.body,
        bodyTruncated: captured.truncated,
        outcome: "complete"
      }
      record.client.error = null
      completeRecord(record, this.#now())
    })
  }

  finishClientError(requestId: string | undefined, error: unknown): void {
    if (!requestId) return
    const apiError = asApiError(error)
    const captured = captureValue(openAIErrorBody(apiError))
    this.#update(requestId, (record) => {
      if (record.completedAt) return
      record.client.result = {
        status: apiError.status,
        statusText: "",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: captured.body,
        bodyTruncated: captured.truncated,
        outcome: "complete"
      }
      record.client.error = sanitizeError(apiError)
      completeRecord(record, this.#now())
    })
  }

  observeClientStream(
    requestId: string | undefined,
    body: ReadableStream<Uint8Array>,
    input: { status?: number; statusText?: string; headers?: HeaderSource } = {}
  ): ReadableStream<Uint8Array> {
    if (!requestId || !this.#find(requestId)) return body
    const metadata = {
      status: input.status ?? 200,
      statusText: input.statusText ?? "OK",
      headers: input.headers ?? { "content-type": "text/event-stream; charset=utf-8" }
    }
    return observeStream(body, {
      onComplete: (captured) => this.#finishClientStream(requestId, metadata, captured, "complete"),
      onCancel: (captured) => this.#finishClientStream(requestId, metadata, captured, "cancelled"),
      onError: (captured, error) => {
        this.#finishClientStream(requestId, metadata, captured, "complete", error)
      }
    })
  }

  beginUpstreamRequest(requestId: string | undefined, input: BeginUpstreamRequestInput): string | undefined {
    if (!requestId) return undefined
    const record = this.#find(requestId)
    if (!record) return undefined
    const captured = captureValue(input.body)
    const timestamp = this.#now()
    const attemptId = this.#createId()
    const attempt: RequestLogUpstreamAttempt = {
      id: attemptId,
      sequence: record.upstream.length + 1,
      accountId: sanitizeText(input.accountId),
      startedAt: new Date(timestamp).toISOString(),
      completedAt: null,
      durationMs: null,
      request: {
        method: sanitizeMethod(input.method),
        url: sanitizeUrl(input.url),
        headers: sanitizeHeaders(input.headers),
        body: captured.body,
        bodyTruncated: captured.truncated
      },
      response: null,
      error: null
    }
    record.upstream.push(attempt)
    this.#recalculateAndTrim()
    return attemptId
  }

  finishUpstreamError(requestId: string | undefined, attemptId: string | undefined, error: unknown): void {
    if (!requestId || !attemptId) return
    this.#update(requestId, (record) => {
      const attempt = record.upstream.find((candidate) => candidate.id === attemptId)
      if (!attempt || attempt.completedAt) return
      attempt.error = sanitizeError(error)
      completeAttempt(attempt, this.#now())
    })
  }

  observeUpstreamResponse(
    requestId: string | undefined,
    attemptId: string | undefined,
    response: Response
  ): Response {
    if (!requestId || !attemptId || !this.#find(requestId)) return response
    const metadata = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }
    if (!response.body) {
      this.#finishUpstreamResponse(requestId, attemptId, metadata, { body: null, truncated: false }, "complete")
      return response
    }
    const body = observeStream(response.body, {
      onComplete: (captured) => this.#finishUpstreamResponse(requestId, attemptId, metadata, captured, "complete"),
      onCancel: (captured) => this.#finishUpstreamResponse(requestId, attemptId, metadata, captured, "cancelled"),
      onError: (captured, error) => {
        this.#finishUpstreamResponse(requestId, attemptId, metadata, captured, "complete", error)
      }
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }

  #finishClientStream(
    requestId: string,
    metadata: { status: number; statusText: string; headers: HeaderSource },
    captured: CapturedBody,
    outcome: "complete" | "cancelled",
    error?: unknown
  ): void {
    this.#update(requestId, (record) => {
      if (record.completedAt) return
      record.client.result = {
        status: metadata.status,
        statusText: sanitizeText(metadata.statusText),
        headers: sanitizeHeaders(metadata.headers),
        body: captured.body,
        bodyTruncated: captured.truncated,
        outcome
      }
      record.client.error = error === undefined ? null : sanitizeError(error)
      completeRecord(record, this.#now())
    })
  }

  #finishUpstreamResponse(
    requestId: string,
    attemptId: string,
    metadata: { status: number; statusText: string; headers: HeaderSource },
    captured: CapturedBody,
    outcome: "complete" | "cancelled",
    error?: unknown
  ): void {
    this.#update(requestId, (record) => {
      const attempt = record.upstream.find((candidate) => candidate.id === attemptId)
      if (!attempt || attempt.completedAt) return
      attempt.response = {
        status: metadata.status,
        statusText: sanitizeText(metadata.statusText),
        headers: sanitizeHeaders(metadata.headers),
        body: captured.body,
        bodyTruncated: captured.truncated,
        outcome
      }
      attempt.error = error === undefined ? null : sanitizeError(error)
      completeAttempt(attempt, this.#now())
    })
  }

  #find(requestId: string): RequestLogRecord | undefined {
    return this.#records.find((record) => record.id === requestId)
  }

  #update(requestId: string, mutator: (record: RequestLogRecord) => void): void {
    const record = this.#find(requestId)
    if (!record) return
    mutator(record)
    this.#recalculateAndTrim()
  }

  #recalculateAndTrim(): void {
    const sizes = this.#records.map(serializedBytes)
    this.#totalBytes = sizes.reduce((sum, size) => sum + size, 0)
    while (this.#records.length > REQUEST_LOG_MAX_RECORDS || this.#totalBytes > REQUEST_LOG_MAX_TOTAL_BYTES) {
      const removedSize = sizes.shift() ?? serializedBytes(this.#records[0])
      this.#records.shift()
      this.#totalBytes -= removedSize
    }
  }
}

function completeRecord(record: RequestLogRecord, completedAt: number): void {
  const startedAt = Date.parse(record.startedAt)
  record.completedAt = new Date(completedAt).toISOString()
  record.durationMs = Math.max(0, completedAt - startedAt)
}

function completeAttempt(attempt: RequestLogUpstreamAttempt, completedAt: number): void {
  const startedAt = Date.parse(attempt.startedAt)
  attempt.completedAt = new Date(completedAt).toISOString()
  attempt.durationMs = Math.max(0, completedAt - startedAt)
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function sanitizeMethod(value: string): string {
  const method = value.trim().toUpperCase()
  return /^[A-Z]{1,20}$/.test(method) ? method : "UNKNOWN"
}

function sanitizeUrl(value: string): string {
  const isRelative = value.startsWith("/")
  try {
    const url = new URL(value, "http://request-log.invalid")
    if (url.username) url.username = REDACTED
    if (url.password) url.password = REDACTED
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) url.searchParams.set(key, REDACTED)
      else {
        const values = url.searchParams.getAll(key).map(sanitizeText)
        url.searchParams.delete(key)
        for (const item of values) url.searchParams.append(key, item)
      }
    }
    const sanitized = isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString()
    return truncateString(sanitized, MAX_CAPTURED_STRING_CHARACTERS)
  } catch {
    return truncateString(sanitizeText(value), MAX_CAPTURED_STRING_CHARACTERS)
  }
}

function sanitizeHeaders(source?: HeaderSource): RequestLogHeaders {
  if (!source) return {}
  const entries: Array<[string, string]> = []
  if (source instanceof Headers) {
    for (const [name, value] of source.entries()) entries.push([name, value])
  } else {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue
      entries.push([name, Array.isArray(value) ? value.join(", ") : value])
    }
  }
  const result: RequestLogHeaders = {}
  for (const [rawName, rawValue] of entries.slice(0, MAX_HEADER_COUNT)) {
    const name = truncateString(rawName.toLowerCase(), 256)
    result[name] = isSensitiveName(name)
      ? REDACTED
      : truncateString(sanitizeText(rawValue), MAX_HEADER_VALUE_CHARACTERS)
  }
  if (entries.length > MAX_HEADER_COUNT) result["x-request-log-truncated"] = "true"
  return result
}

function captureValue(value: unknown): CapturedBody {
  if (value === undefined) return { body: null, truncated: false }
  const state: SanitizationState = { truncated: false }
  const sanitized = sanitizeValue(value, undefined, 0, new WeakSet<object>(), state)
  let serialized: string
  try {
    serialized = JSON.stringify(sanitized)
  } catch {
    return { body: "[UNSERIALIZABLE]", truncated: true }
  }
  if (Buffer.byteLength(serialized, "utf8") <= REQUEST_LOG_MAX_BODY_BYTES) {
    return { body: sanitized, truncated: state.truncated }
  }
  return {
    body: truncateJsonString(serialized, REQUEST_LOG_MAX_BODY_BYTES),
    truncated: true
  }
}

function captureText(value: string, truncated: boolean): CapturedBody {
  if (!truncated) {
    try {
      const captured = captureValue(JSON.parse(value))
      return { ...captured, truncated: captured.truncated || truncated }
    } catch {
      // Streaming and non-JSON response bodies remain text.
    }
  }
  const sanitized = sanitizeText(value)
  const bytes = Buffer.byteLength(sanitized, "utf8")
  return {
    body: bytes > REQUEST_LOG_MAX_BODY_BYTES ? truncateUtf8(sanitized, REQUEST_LOG_MAX_BODY_BYTES) : sanitized,
    truncated: truncated || bytes > REQUEST_LOG_MAX_BODY_BYTES
  }
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  depth: number,
  seen: WeakSet<object>,
  state: SanitizationState
): unknown {
  if (key && isSensitiveName(key)) return REDACTED
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") {
    if (value.length > MAX_CAPTURED_STRING_CHARACTERS) state.truncated = true
    return truncateString(sanitizeText(value), MAX_CAPTURED_STRING_CHARACTERS)
  }
  if (typeof value === "bigint") return value.toString()
  if (value === undefined) return null
  if (typeof value !== "object") return truncateString(sanitizeText(String(value)), MAX_CAPTURED_STRING_CHARACTERS)
  if (depth >= MAX_VALUE_DEPTH) {
    state.truncated = true
    return "[MAX_DEPTH]"
  }
  if (seen.has(value)) {
    state.truncated = true
    return "[CIRCULAR]"
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const result = value.slice(0, MAX_COLLECTION_ITEMS)
        .map((item) => sanitizeValue(item, undefined, depth + 1, seen, state))
      if (value.length > MAX_COLLECTION_ITEMS) {
        state.truncated = true
        result.push("[TRUNCATED]")
      }
      return result
    }
    const result: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [childKey, childValue] of entries.slice(0, MAX_COLLECTION_ITEMS)) {
      if (childKey.length > 512) state.truncated = true
      result[truncateString(childKey, 512)] = sanitizeValue(childValue, childKey, depth + 1, seen, state)
    }
    if (entries.length > MAX_COLLECTION_ITEMS) {
      state.truncated = true
      result["[TRUNCATED]"] = true
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function sanitizeError(error: unknown): RequestLogError {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; status?: unknown }
    return {
      name: truncateString(sanitizeText(error.name || "Error"), 120),
      message: truncateString(sanitizeText(error.message || "Request failed"), 4_000),
      code: typeof candidate.code === "string" ? truncateString(sanitizeText(candidate.code), 240) : null,
      status: typeof candidate.status === "number" && Number.isSafeInteger(candidate.status) ? candidate.status : null
    }
  }
  return {
    name: "Error",
    message: truncateString(sanitizeText(typeof error === "string" ? error : "Request failed"), 4_000),
    code: null,
    status: null
  }
}

function isSensitiveName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "")
  if ([
    "authorization",
    "proxyauthorization",
    "auth",
    "cookie",
    "setcookie",
    "password",
    "passwd",
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "apikey",
    "key",
    "xapikey",
    "secret",
    "clientsecret",
    "credential",
    "credentials",
    "session",
    "sessionid",
    "csrf",
    "csrftoken"
  ].includes(normalized)) return true
  return normalized.endsWith("password")
    || normalized.includes("password")
    || normalized.includes("cookie")
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("clientsecret")
}

function sanitizeText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(?:sk|nwk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|\btoken|\bcookie|\bsession|\bsecret|password|passwd|credential|client[_-]?secret)\s*[:=]\s*)[^\s,;&]+/gi, `$1${REDACTED}`)
}

function truncateString(value: string, maximumCharacters: number): string {
  return value.length <= maximumCharacters ? value : `${value.slice(0, maximumCharacters)}...[TRUNCATED]`
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= maximumBytes) return value
  const suffix = "...[TRUNCATED]"
  const available = Math.max(0, maximumBytes - Buffer.byteLength(suffix, "utf8"))
  return `${new TextDecoder().decode(bytes.subarray(0, available))}${suffix}`
}

function truncateJsonString(value: string, maximumBytes: number): string {
  const suffix = "...[TRUNCATED]"
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${value.slice(0, middle)}${suffix}`
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maximumBytes) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low)}${suffix}`
}

function createStreamCapture(): StreamCapture {
  const chunks: Uint8Array[] = []
  let capturedBytes = 0
  let totalBytes = 0
  return {
    append(chunk) {
      totalBytes += chunk.byteLength
      if (capturedBytes >= REQUEST_LOG_MAX_BODY_BYTES) return
      const remaining = REQUEST_LOG_MAX_BODY_BYTES - capturedBytes
      const copy = chunk.slice(0, remaining)
      chunks.push(copy)
      capturedBytes += copy.byteLength
    },
    finish() {
      const bytes = new Uint8Array(capturedBytes)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return captureText(new TextDecoder().decode(bytes), totalBytes > capturedBytes)
    }
  }
}

function observeStream(
  source: ReadableStream<Uint8Array>,
  callbacks: {
    onComplete(captured: CapturedBody): void
    onCancel(captured: CapturedBody): void
    onError(captured: CapturedBody, error: unknown): void
  }
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const capture = createStreamCapture()
  let settled = false
  const settle = (kind: "complete" | "cancel" | "error", error?: unknown): void => {
    if (settled) return
    settled = true
    const captured = capture.finish()
    if (kind === "complete") callbacks.onComplete(captured)
    else if (kind === "cancel") callbacks.onCancel(captured)
    else callbacks.onError(captured, error)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          try {
            reader.releaseLock()
          } catch {
            // The source may already have released its reader.
          }
          settle("complete")
          controller.close()
          return
        }
        capture.append(next.value)
        controller.enqueue(next.value)
      } catch (error) {
        try {
          reader.releaseLock()
        } catch {
          // The failed source may already have released its reader.
        }
        settle("error", error)
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // Cancellation can release the reader first.
        }
        settle("cancel")
      }
    }
  })
}
