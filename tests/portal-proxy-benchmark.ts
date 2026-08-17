// Manual direct-portal versus local-proxy SSE benchmark.
// It reads local credentials only to make equivalent requests and never prints them.
// Run: corepack pnpm run benchmark:portal
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import YAML from "yaml"

interface LocalStore {
  proxy?: {
    apiKey?: string
    keys?: Array<{ value?: string; enabled?: boolean }>
  }
  accounts?: Array<{ cookie?: string; enabled?: boolean }>
}

interface StreamMetrics {
  status: number
  contentType: string | null
  headersMs: number
  firstDataMs: number | null
  firstContentMs: number | null
  totalMs: number
  frames: number
  dataFrames: number
  bytes: number
  done: boolean
  streamError: boolean
  finishReason: string | null
}

const portalOrigin = process.env.NEURALWATT_BENCH_PORTAL_ORIGIN || "https://portal.neuralwatt.com"
const proxyOrigin = process.env.NEURALWATT_BENCH_PROXY_ORIGIN || "http://127.0.0.1:3000"
const model = process.env.NEURALWATT_BENCH_MODEL || "kimi-k3"
const maxTokens = positiveInteger(process.env.NEURALWATT_BENCH_MAX_TOKENS, 2048)
const trials = positiveInteger(process.env.NEURALWATT_BENCH_TRIALS, 3)

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function loadBenchmarkCredentials(): { cookie: string; proxyKey: string } {
  const store = YAML.parse(readFileSync(resolve(process.cwd(), ".data", "neuralwatt-accounts.yaml"), "utf8")) as LocalStore
  const enabled = (store.accounts || []).filter((account) => account.enabled !== false && account.cookie?.trim())
  if (enabled.length !== 1) {
    throw new Error("benchmark requires exactly one enabled account with a saved Cookie so both endpoints use the same portal session")
  }

  const cookie = enabled[0].cookie!.trim()
  const savedProxyKey = store.proxy?.keys?.find((key) => key.enabled !== false && key.value?.trim())?.value || store.proxy?.apiKey
  const proxyKey = process.env.NEURALWATT_BENCH_PROXY_KEY || savedProxyKey
  if (!proxyKey?.trim()) {
    throw new Error("proxy key is unavailable; set NEURALWATT_BENCH_PROXY_KEY for this benchmark")
  }

  return { cookie, proxyKey: proxyKey.trim() }
}

function takeFrame(buffer: string): { frame: string; rest: string } | null {
  const lfIndex = buffer.indexOf("\n\n")
  const crlfIndex = buffer.indexOf("\r\n\r\n")
  if (lfIndex < 0 && crlfIndex < 0) return null

  const useCrlf = crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)
  const index = useCrlf ? crlfIndex : lfIndex
  return {
    frame: buffer.slice(0, index),
    rest: buffer.slice(index + (useCrlf ? 4 : 2))
  }
}

function dataFromFrame(frame: string): string | null {
  const values = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
  return values.length > 0 ? values.join("\n") : null
}

function observeData(data: string, elapsedMs: number, metrics: StreamMetrics): void {
  metrics.dataFrames += 1
  if (metrics.firstDataMs === null) metrics.firstDataMs = elapsedMs
  if (data.trim() === "[DONE]") {
    metrics.done = true
    return
  }

  try {
    const value = JSON.parse(data) as {
      error?: unknown
      choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>
    }
    if (value.error !== undefined) metrics.streamError = true
    const choice = value.choices?.[0]
    if (typeof choice?.finish_reason === "string") metrics.finishReason = choice.finish_reason
    if (typeof choice?.delta?.content === "string" && choice.delta.content.length > 0 && metrics.firstContentMs === null) {
      metrics.firstContentMs = elapsedMs
    }
  } catch {
    metrics.streamError = true
  }
}

async function measure(url: string, headers: HeadersInit, body: Record<string, unknown>): Promise<StreamMetrics> {
  const startedAt = performance.now()
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  })
  const headersMs = performance.now() - startedAt
  const metrics: StreamMetrics = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    headersMs,
    firstDataMs: null,
    firstContentMs: null,
    totalMs: headersMs,
    frames: 0,
    dataFrames: 0,
    bytes: 0,
    done: false,
    streamError: false,
    finishReason: null
  }

  if (!response.body) {
    metrics.totalMs = performance.now() - startedAt
    return metrics
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      metrics.bytes += next.value.byteLength
      pending += decoder.decode(next.value, { stream: true })
      while (true) {
        const nextFrame = takeFrame(pending)
        if (!nextFrame) break
        pending = nextFrame.rest
        metrics.frames += 1
        const data = dataFromFrame(nextFrame.frame)
        if (data !== null) observeData(data, performance.now() - startedAt, metrics)
      }
    }
    pending += decoder.decode()
  } finally {
    reader.releaseLock()
  }

  metrics.totalMs = performance.now() - startedAt
  return metrics
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}ms`
}

function report(label: string, value: StreamMetrics): void {
  console.log(
    `${label} status=${value.status} headers=${formatMs(value.headersMs)} first_data=${formatMs(value.firstDataMs)} first_content=${formatMs(value.firstContentMs)} total=${formatMs(value.totalMs)} done=${value.done ? "yes" : "no"} stream_error=${value.streamError ? "yes" : "no"} finish=${value.finishReason ?? "none"} frames=${value.frames} data_frames=${value.dataFrames} bytes=${value.bytes}`
  )
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function delta(proxyValue: number | null, portalValue: number | null): number | null {
  return proxyValue === null || portalValue === null ? null : proxyValue - portalValue
}

async function main(): Promise<void> {
  const { cookie, proxyKey } = loadBenchmarkCredentials()
  const request = {
    model,
    messages: [{ role: "user", content: "Reply with exactly BASELINE_OK." }],
    stream: true,
    temperature: 0.7,
    top_p: 1,
    max_tokens: maxTokens
  }
  const portalMetrics: StreamMetrics[] = []
  const proxyMetrics: StreamMetrics[] = []

  console.log(`portal=${portalOrigin}/api/chat proxy=${proxyOrigin}/v1/chat/completions model=${model} max_tokens=${maxTokens} trials=${trials}`)
  console.log("The request body is identical at both endpoints; no response content or credentials are logged.")

  for (let trial = 0; trial < trials; trial += 1) {
    const portalFirst = trial % 2 === 0
    const portalRequest = () => measure(`${portalOrigin}/api/chat`, {
      accept: "text/event-stream",
      "content-type": "application/json",
      cookie
    }, request)
    const proxyRequest = () => measure(`${proxyOrigin}/v1/chat/completions`, {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${proxyKey}`
    }, request)

    const first = portalFirst ? await portalRequest() : await proxyRequest()
    const second = portalFirst ? await proxyRequest() : await portalRequest()
    const portal = portalFirst ? first : second
    const proxy = portalFirst ? second : first
    portalMetrics.push(portal)
    proxyMetrics.push(proxy)

    console.log(`\ntrial=${trial + 1} order=${portalFirst ? "portal->proxy" : "proxy->portal"}`)
    report("portal", portal)
    report("proxy ", proxy)
    console.log(`delta proxy-portal headers=${formatMs(delta(proxy.headersMs, portal.headersMs))} first_data=${formatMs(delta(proxy.firstDataMs, portal.firstDataMs))} total=${formatMs(delta(proxy.totalMs, portal.totalMs))}`)
  }

  const portalHeaders = average(portalMetrics.map((item) => item.headersMs))
  const proxyHeaders = average(proxyMetrics.map((item) => item.headersMs))
  const portalFirstData = average(portalMetrics.flatMap((item) => item.firstDataMs === null ? [] : [item.firstDataMs]))
  const proxyFirstData = average(proxyMetrics.flatMap((item) => item.firstDataMs === null ? [] : [item.firstDataMs]))
  const portalTotal = average(portalMetrics.map((item) => item.totalMs))
  const proxyTotal = average(proxyMetrics.map((item) => item.totalMs))

  console.log("\n=== average delta (proxy - portal) ===")
  console.log(`headers=${formatMs(delta(proxyHeaders, portalHeaders))} first_data=${formatMs(delta(proxyFirstData, portalFirstData))} total=${formatMs(delta(proxyTotal, portalTotal))}`)
  console.log(`portal_complete=${portalMetrics.filter((item) => item.done).length}/${trials} proxy_complete=${proxyMetrics.filter((item) => item.done).length}/${trials}`)
}

void main()
