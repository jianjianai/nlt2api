import { ApiError } from "../shared/errors"

export interface SseEvent {
  event?: string
  id?: string
  data: string
}

export class SseDecoder {
  private buffer = ""

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    return this.drain(false)
  }

  finish(): SseEvent[] {
    return this.drain(true)
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = []
    while (true) {
      const boundary = findBoundary(this.buffer)
      if (!boundary) break
      const frame = this.buffer.slice(0, boundary.index)
      this.buffer = this.buffer.slice(boundary.index + boundary.length)
      const event = parseFrame(frame)
      if (event) events.push(event)
    }

    if (final && this.buffer.length > 0) {
      const event = parseFrame(this.buffer)
      this.buffer = ""
      if (event) events.push(event)
    }
    return events
  }
}

function findBoundary(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n")
  const crlf = value.indexOf("\r\n\r\n")
  const cr = value.indexOf("\r\r")
  const candidates = [
    lf >= 0 ? { index: lf, length: 2 } : undefined,
    crlf >= 0 ? { index: crlf, length: 4 } : undefined,
    cr >= 0 ? { index: cr, length: 2 } : undefined
  ].filter((item): item is { index: number; length: number } => item !== undefined)
  return candidates.sort((left, right) => left.index - right.index)[0]
}

function parseFrame(frame: string): SseEvent | undefined {
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined

  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") data.push(value)
    else if (field === "event") event = value
    else if (field === "id" && !value.includes("\0")) id = value
  }

  if (data.length === 0) return undefined
  return { data: data.join("\n"), ...(event ? { event } : {}), ...(id ? { id } : {}) }
}

export function parseSseJson(data: string): Record<string, unknown> | "[DONE]" {
  if (data.trim() === "[DONE]") return "[DONE]"
  try {
    const value: unknown = JSON.parse(data)
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("SSE data is not a JSON object")
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new ApiError("The NeuralWatt portal returned invalid SSE data", {
      status: 502,
      code: "invalid_upstream_sse",
      cause: error
    })
  }
}
