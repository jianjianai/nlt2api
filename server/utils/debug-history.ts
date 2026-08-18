import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { clearDebugTraceStorage, getDebugTraceDirectory, isDebugTraceEnabled, isDebugTraceId } from "./debug"
import { AppError } from "./errors"

type JsonObject = Record<string, unknown>

export type DebugRecordType = "trace" | "client-request" | "upstream-request" | "upstream-response" | "client-response"

export interface DebugTraceRecord {
  sequence: number
  type: DebugRecordType
  recordedAt: string
  metadata: JsonObject
  body: unknown
}

export interface DebugTraceSummary {
  id: string
  createdAt: string
  updatedAt: string
  model: string | null
  messageCount: number | null
  preview: string | null
  recordCount: number
  upstreamAttempts: number
  completed: boolean
}

export interface DebugTracePage {
  enabled: boolean
  page: number
  pageSize: number
  total: number
  traces: DebugTraceSummary[]
}

export interface DebugTraceDetail {
  id: string
  createdAt: string
  records: DebugTraceRecord[]
}

const RECORD_TYPES = new Set<DebugRecordType>([
  "trace",
  "client-request",
  "upstream-request",
  "upstream-response",
  "client-response"
])
const RECORD_FILE_PATTERN = /^(\d+)-([a-z0-9-]+)\.json$/i
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const PREVIEW_LENGTH = 160

interface DebugDirectoryEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

async function readDirectory(directory: string): Promise<DebugDirectoryEntry[]> {
  return readdir(directory, { withFileTypes: true }) as unknown as Promise<DebugDirectoryEntry[]>
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return stringify(value)

  return value.map((part) => {
    if (!isRecord(part)) return stringify(part)
    if (typeof part.text === "string") return part.text
    if (isRecord(part.image_url)) return "[image]"
    return stringify(part)
  }).join(" ")
}

function preview(value: unknown): string | null {
  const text = contentText(value).replace(/\s+/g, " ").trim()
  if (!text) return null
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text
}

function traceTimestamp(id: string): string {
  const match = id.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/)
  return match ? `${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : id
}

function recordDescriptor(name: string): { sequence: number; type: DebugRecordType } | undefined {
  const match = name.match(RECORD_FILE_PATTERN)
  if (!match) return undefined
  const sequence = Number(match[1])
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !RECORD_TYPES.has(match[2] as DebugRecordType)) return undefined
  return { sequence, type: match[2] as DebugRecordType }
}

function traceDirectory(id: string): string {
  if (!isDebugTraceId(id)) {
    throw new AppError("The requested debug trace does not exist", 404, "debug_trace_not_found")
  }
  return join(getDebugTraceDirectory(), id)
}

async function traceEntries(id: string): Promise<DebugDirectoryEntry[]> {
  try {
    return await readDirectory(traceDirectory(id))
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new AppError("The requested debug trace does not exist", 404, "debug_trace_not_found")
    }
    throw new AppError("The debug trace could not be read", 500, "debug_trace_read_failed")
  }
}

async function readTraceRecord(directory: string, id: string, fileName: string): Promise<DebugTraceRecord | undefined> {
  const descriptor = recordDescriptor(fileName)
  if (!descriptor) return undefined

  try {
    const value: unknown = JSON.parse(await readFile(join(directory, fileName), "utf8"))
    if (!isRecord(value) || value.trace_id !== id || value.record_type !== descriptor.type || typeof value.recorded_at !== "string") {
      return undefined
    }
    return {
      sequence: descriptor.sequence,
      type: descriptor.type,
      recordedAt: value.recorded_at,
      metadata: isRecord(value.metadata) ? value.metadata : {},
      body: value.body
    }
  } catch {
    // A trace may be inspected while an asynchronous capture write is incomplete.
    return undefined
  }
}

async function readTraceRecords(id: string): Promise<DebugTraceRecord[]> {
  const directory = traceDirectory(id)
  const entries = await traceEntries(id)
  const records = await Promise.all(entries
    .filter((entry) => entry.isFile() && recordDescriptor(entry.name) !== undefined)
    .map((entry) => readTraceRecord(directory, id, entry.name)))
  return records
    .filter((record): record is DebugTraceRecord => record !== undefined)
    .sort((left, right) => left.sequence - right.sequence)
}

async function listTraceIds(): Promise<string[]> {
  try {
    const entries = await readDirectory(getDebugTraceDirectory())
    return entries
      .filter((entry) => entry.isDirectory() && isDebugTraceId(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw new AppError("The debug history could not be read", 500, "debug_history_read_failed")
  }
}

async function summarizeTrace(id: string): Promise<DebugTraceSummary | undefined> {
  try {
    const directory = traceDirectory(id)
    const entries = await traceEntries(id)
    const descriptors = entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, descriptor: recordDescriptor(entry.name) }))
      .filter((entry): entry is { name: string; descriptor: { sequence: number; type: DebugRecordType } } => entry.descriptor !== undefined)
    const traceFile = descriptors.find((entry) => entry.descriptor.type === "trace")
    const clientRequestFile = descriptors.find((entry) => entry.descriptor.type === "client-request")
    const latestFile = [...descriptors].sort((left, right) => right.descriptor.sequence - left.descriptor.sequence)[0]
    const [trace, clientRequest, latest] = await Promise.all([
      traceFile ? readTraceRecord(directory, id, traceFile.name) : undefined,
      clientRequestFile ? readTraceRecord(directory, id, clientRequestFile.name) : undefined,
      latestFile ? readTraceRecord(directory, id, latestFile.name) : undefined
    ])
    if (!trace && !clientRequest) return undefined

    const request = clientRequest ? parseBody(clientRequest.body) : undefined
    const payload = isRecord(request) ? request : {}
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const userMessage = [...messages].reverse().find((message) => isRecord(message) && message.role === "user")
    const createdAt = trace?.recordedAt ?? clientRequest?.recordedAt ?? traceTimestamp(id)
    const updatedAt = latest?.recordedAt ?? clientRequest?.recordedAt ?? createdAt
    return {
      id,
      createdAt,
      updatedAt,
      model: typeof payload.model === "string" ? payload.model : null,
      messageCount: Array.isArray(payload.messages) ? payload.messages.length : null,
      preview: isRecord(userMessage) ? preview(userMessage.content) : null,
      recordCount: descriptors.length,
      upstreamAttempts: descriptors.filter((entry) => entry.descriptor.type === "upstream-request").length,
      completed: descriptors.some((entry) => entry.descriptor.type === "client-response")
    }
  } catch {
    return undefined
  }
}

export function debugPageNumber(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

export function debugPageSize(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

export async function listDebugTraces(page = 1, pageSize = DEFAULT_PAGE_SIZE): Promise<DebugTracePage> {
  const ids = await listTraceIds()
  const summaries = (await Promise.all(ids.map(summarizeTrace)))
    .filter((summary): summary is DebugTraceSummary => summary !== undefined)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt)
      const rightTime = Date.parse(right.updatedAt)
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
      return right.id.localeCompare(left.id)
    })
  const start = (page - 1) * pageSize
  return {
    enabled: isDebugTraceEnabled(),
    page,
    pageSize,
    total: summaries.length,
    traces: summaries.slice(start, start + pageSize)
  }
}

export async function getDebugTraceDetail(id: string): Promise<DebugTraceDetail> {
  const records = await readTraceRecords(id)
  if (records.length === 0) {
    throw new AppError("The requested debug trace does not exist", 404, "debug_trace_not_found")
  }
  return {
    id,
    createdAt: records.find((record) => record.type === "trace")?.recordedAt ?? records[0].recordedAt,
    records
  }
}

export function clearDebugHistory(): Promise<number> {
  return clearDebugTraceStorage()
}
