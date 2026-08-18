import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

type JsonObject = Record<string, unknown>

export interface DebugTrace {
  readonly id: string
  readonly directory: string
  recordJson(label: string, body: unknown, metadata?: JsonObject): Promise<void>
  recordText(label: string, body: string, metadata?: JsonObject): Promise<void>
  captureStream(label: string, stream: ReadableStream<Uint8Array>, metadata?: JsonObject): ReadableStream<Uint8Array>
  close(): void
}

const DEFAULT_MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const sensitiveKeyPattern = /authorization|cookie|password|api[_-]?key|token|secret|credential/i

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/("(?:authorization|cookie|password|api[_-]?key|token|secret|credential)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, "$1\"[REDACTED]\"")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|password|cookie|token|secret)\s*([=:])\s*[^\s,;\"']+/gi, "$1$2[REDACTED]")
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (sensitiveKeyPattern.test(key ?? "")) return "[REDACTED]"
    return redactInlineSecrets(value)
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item))
  if (!isRecord(value)) return value

  const sanitized: JsonObject = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    sanitized[childKey] = sanitizeValue(childValue, childKey)
  }
  return sanitized
}

function sanitizeText(body: string): string {
  try {
    return JSON.stringify(sanitizeValue(JSON.parse(body)))
  } catch {
    return redactInlineSecrets(body)
  }
}

function captureLimit(value: unknown = process.env.NEURALWATT_DEBUG_MAX_BYTES): number {
  const configured = Number(value)
  if (!Number.isSafeInteger(configured) || configured < 1024) return DEFAULT_MAX_CAPTURE_BYTES
  return configured
}

function captureDirectory(): string {
  return resolve(process.env.NEURALWATT_DEBUG_DIR ?? join(process.cwd(), ".data", "debug"))
}

function traceEnabled(): boolean {
  return process.env.NEURALWATT_DEBUG_TRACE === "1"
}

const TRACE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const activeTraces = new Set<FileDebugTrace>()
let storageBarrier: Promise<void> = Promise.resolve()

export function isDebugTraceEnabled(): boolean {
  return traceEnabled()
}

export function getDebugTraceDirectory(): string {
  return captureDirectory()
}

export function isDebugTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value)
}

function queueStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = storageBarrier
  let release: (() => void) | undefined
  storageBarrier = new Promise<void>((resolve) => {
    release = resolve
  })
  return previous.then(operation).finally(() => release?.())
}

function safeLabel(label: string): string {
  return label.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? redactInlineSecrets(error.message) : "stream cancelled"
}

export interface DebugTraceOptions {
  enabled?: boolean
  directory?: string
  maxCaptureBytes?: number
}

class FileDebugTrace implements DebugTrace {
  readonly id: string
  readonly directory: string
  #maxCaptureBytes: number
  #recordIndex = 0
  #writeChain: Promise<void> = Promise.resolve()
  #closed = false
  constructor(id: string, directory: string, maxCaptureBytes: number) {
    this.id = id
    this.directory = directory
    this.#maxCaptureBytes = maxCaptureBytes
  }

  close(): void {
    this.#closed = true
    activeTraces.delete(this)
  }

  async waitForWrites(): Promise<void> {
    await this.#writeChain
  }

  async recordJson(label: string, body: unknown, metadata: JsonObject = {}): Promise<void> {
    await this.#write(label, sanitizeValue(body), metadata)
  }

  async recordText(label: string, body: string, metadata: JsonObject = {}): Promise<void> {
    await this.#write(label, sanitizeText(body), metadata)
    if (label === "client-response") this.close()
  }

  captureStream(label: string, stream: ReadableStream<Uint8Array>, metadata: JsonObject = {}): ReadableStream<Uint8Array> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    const hash = createHash("sha256")
    const limit = this.#maxCaptureBytes
    let totalBytes = 0
    let capturedBytes = 0
    let finished = false

    const finish = async (state: "complete" | "cancelled" | "errored", error?: unknown): Promise<void> => {
      if (finished) return
      finished = true
      const captured = joinChunks(chunks, capturedBytes)
      try {
        await this.recordText(label, new TextDecoder().decode(captured), {
          ...metadata,
          stream_state: state,
          total_bytes: totalBytes,
          captured_bytes: capturedBytes,
          truncated: totalBytes > capturedBytes,
          sha256: hash.digest("hex"),
          ...(error === undefined ? {} : { error: errorMessage(error) })
        })
      } finally {
        if (label === "client-response") this.close()
      }
    }

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            await finish("complete")
            controller.close()
            return
          }

          totalBytes += next.value.length
          hash.update(next.value)
          if (capturedBytes < limit) {
            const available = limit - capturedBytes
            const slice = next.value.length > available ? next.value.slice(0, available) : next.value.slice()
            chunks.push(slice)
            capturedBytes += slice.length
          }
          controller.enqueue(next.value)
        } catch (error) {
          await finish("errored", error)
          controller.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          await finish("cancelled", reason)
        }
      }
    })
  }

  async #write(label: string, body: unknown, metadata: JsonObject): Promise<void> {
    if (this.#closed) return
    const index = String(++this.#recordIndex).padStart(3, "0")
    const file = join(this.directory, `${index}-${safeLabel(label)}.json`)
    const record = JSON.stringify({
      trace_id: this.id,
      record_type: label,
      recorded_at: new Date().toISOString(),
      metadata: sanitizeValue(metadata),
      body
    }, null, 2)

    const write = this.#writeChain.then(async () => {
      if (this.#closed) return
      await writeFile(file, record, { encoding: "utf8", mode: 0o600 })
    })
    this.#writeChain = write.catch((error) => {
      console.error(`[debug] trace write failed: ${errorMessage(error)}`)
    })
    await write.catch(() => undefined)
  }
}

export async function createDebugTrace(options: DebugTraceOptions = {}): Promise<DebugTrace | undefined> {
  if (!(options.enabled ?? traceEnabled())) return undefined

  return queueStorageOperation(async () => {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`
    const rootDirectory = options.directory ? resolve(options.directory) : captureDirectory()
    const maxCaptureBytes = captureLimit(options.maxCaptureBytes)
    const directory = join(rootDirectory, id)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const trace = new FileDebugTrace(id, directory, maxCaptureBytes)
      activeTraces.add(trace)
      console.info(`[debug] trace directory=${directory}`)
      await trace.recordJson("trace", {
        enabled: true,
        max_capture_bytes: maxCaptureBytes
      })
      return trace
    } catch (error) {
      console.error(`[debug] trace initialization failed: ${errorMessage(error)}`)
      return undefined
    }
  })
}

export function clearDebugTraceStorage(): Promise<number> {
  return queueStorageOperation(async () => {
    const traces = [...activeTraces]
    for (const trace of traces) trace.close()
    await Promise.all(traces.map((trace) => trace.waitForWrites()))

    const rootDirectory = captureDirectory()
    let entries
    try {
      entries = await readdir(rootDirectory, { withFileTypes: true })
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return 0
      throw error
    }

    let cleared = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !isDebugTraceId(entry.name)) continue
      await rm(join(rootDirectory, entry.name), { recursive: true, force: true })
      cleared += 1
    }
    return cleared
  })
}

export async function captureDebugResponse(
  trace: DebugTrace | undefined,
  label: string,
  response: Response,
  extraMetadata: JsonObject = {}
): Promise<Response> {
  if (!trace) return response

  const metadata: JsonObject = {
    ...extraMetadata,
    http_status: response.status,
    status_text: response.statusText,
    content_type: response.headers.get("content-type") ?? null
  }
  if (!response.body) {
    await trace.recordText(label, "", metadata)
    return response
  }
  if (!response.ok) {
    try {
      await trace.recordText(label, await response.clone().text(), metadata)
    } catch (error) {
      await trace.recordJson(label, { capture_error: errorMessage(error) }, metadata)
    }
    return response
  }

  return new Response(trace.captureStream(label, response.body, metadata), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
