// XML tool-protocol benchmark for the Kimi tool loop.
// Mirrors the proxy loop: accumulate delta.content, parse the XML action,
// append a corrective nudge on failure, and retry (max 5).
// Run manually: npx tsx tests/format-benchmark.ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import YAML from "yaml"
import { buildToolProtocol, parseToolAction, parseToolPlan, ToolActionError, type ToolPlan } from "../server/utils/tools"

const TRIALS = 12
const FORMATS = ["compact", "verbose"] as const
const MAX_RETRIES = 5
const MAX_TOKENS = 1024
const MODEL = "kimi-k3"
const TOOL_NAME = "calculate"

interface Outcome {
  format: "compact" | "verbose"
  attempts: number
  failedAfterRetries: boolean
  failures: string[]
  lengthTruncations: number
  outputChars: number
  outputTokens: number
  contentHead: string
  failedContents: string[]
}
function nudgeFor(content: string, error: unknown, plan: ToolPlan, format: "compact" | "verbose"): string {
  const contract = format === "compact"
    ? "Return one compact XML action using the system protocol."
    : "Return one verbose XML action using the system protocol."
  const failure = error instanceof ToolActionError ? error.failure : undefined
  if (failure?.kind === "empty_content") return `Your previous reply was empty. ${contract}`
  if (content.trim() && !content.trim().startsWith("<")) {
    return `Your previous reply was unmarked prose; the proxy did not run a tool. Return the XML action now. ${contract}`
  }
  if (failure?.kind === "schema_validation") return `Arguments failed schema validation. ${contract}`
  return `Your previous reply did not provide a usable XML action${failure ? ` (${failure.kind})` : ""}. ${contract}`
}
async function portalChat(cookie: string, messages: Array<{ role: string; content: string }>): Promise<{ content: string; finishReason: string; doneSentinel: boolean; completionTokens: number }> {
  const url = process.env.NEURALWATT_PORTAL_ORIGIN || "https://portal.neuralwatt.com"
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/json", cookie },
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: true,
          max_tokens: MAX_TOKENS
        })
      })
      if (!response.ok || !response.body) {
        throw new Error(`portal status=${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let content = ""
      let finishReason = ""
      let doneSentinel = false
      let completionTokens = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = frame.split("\n").find((l) => l.startsWith("data:"))
          if (!line) continue
          if (line.trim() === "data: [DONE]") {
            doneSentinel = true
            continue
          }
          try {
            const data = JSON.parse(line.slice(5).trim()) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>
              usage?: { completion_tokens?: number }
            }
            const choice = data.choices?.[0]
            if (typeof data.usage?.completion_tokens === "number") completionTokens = data.usage.completion_tokens
            if (typeof choice?.delta?.content === "string") content += choice.delta.content
            if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason
          } catch {
            // ignore non-JSON frames
          }
        }
      }
      return { content, finishReason, doneSentinel, completionTokens }
    } catch (error) {
      lastError = error
      console.warn(`[bench] portal fetch attempt ${attempt}/3 failed: ${error instanceof Error ? error.message : "unknown"}`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000 * attempt))
    }
  }
  throw lastError
}

async function runTrial(cookie: string, format: "compact" | "verbose", task: string): Promise<Outcome> {
  const plan = parseToolPlan({
    tools: [{
      type: "function",
      function: {
        name: TOOL_NAME,
        description: "Evaluate a math expression",
        parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] }
      }
    }],
    tool_choice: "required",
    parallel_tool_calls: false
  }, "text")
  if (!plan) throw new Error("plan failed")

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: buildToolProtocol(plan, format) },
    { role: "user", content: task }
  ]
  const outcome: Outcome = { format, attempts: 0, failedAfterRetries: false, failures: [], lengthTruncations: 0, outputChars: 0, outputTokens: 0, contentHead: "", failedContents: [] }

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    outcome.attempts = attempt
    const { content, finishReason, doneSentinel, completionTokens } = await portalChat(cookie, messages)
    outcome.outputChars += content.length
    outcome.outputTokens += completionTokens
    if (outcome.contentHead === "" && content) outcome.contentHead = content.slice(0, 100)

    if (finishReason === "length" && !content.trim()) {
      // Production continues every length-truncated tool turn instead of repairing it.
      outcome.lengthTruncations += 1
      outcome.failures.push("length_truncation")
      messages.push({ role: "assistant", content: content || "(truncated)" })
      messages.push({ role: "user", content: "Your previous reply was truncated by the output token limit before producing a complete XML action. Continue immediately with minimal reasoning and emit the XML action described in the protocol." })
      continue
    }

    try {
      const parsed = parseToolAction(content, plan, finishReason === "stop" && doneSentinel)
      if (parsed.kind !== "tool_calls") {
        throw new Error(`unexpected parsed kind ${parsed.kind}`)
      }
      break
    } catch (error) {
      const kind = (error as { failure?: { kind?: string } } | null)?.failure?.kind ?? "unknown"
      outcome.failures.push(kind)
      outcome.failedContents.push(content)
      messages.push({ role: "assistant", content })
      messages.push({ role: "user", content: nudgeFor(content, error, plan, format) })
      if (attempt === MAX_RETRIES + 1) outcome.failedAfterRetries = true
    }
  }
  if (outcome.failures.length > 0) console.log(`[bench] ${format} task="${task.slice(0, 24)}" attempts=${outcome.attempts} failures=${outcome.failures.join(",")}\n  failed=${JSON.stringify(outcome.failedContents.map((c) => c.slice(0, 400)))}`)
  return outcome
}

async function main(): Promise<void> {
  const store = YAML.parse(readFileSync(resolve(process.cwd(), ".data", "neuralwatt-accounts.yaml"), "utf8")) as {
    accounts?: Array<{ cookie?: string }>
  }
  const cookie = store.accounts?.[0]?.cookie
  if (!cookie) throw new Error("no stored cookie")

  const tasks = [
    "请使用 calculate 工具计算 1728*36 并返回结果",
    "请使用 calculate 工具计算 (12+7)*5 并返回结果",
    "请使用 calculate 工具计算 9999/3 并返回结果",
    "请使用 calculate 工具计算 2^10 并返回结果",
    "请使用 calculate 工具计算 456*789 并返回结果",
    "请使用 calculate 工具计算 1000-234 并返回结果",
    "请使用 calculate 工具计算 7*8+9 并返回结果",
    "请使用 calculate 工具计算 12345+67890 并返回结果",
    "请使用 calculate 工具计算 314*159 并返回结果",
    "请使用 calculate 工具计算 8888/8 并返回结果",
    "请使用 calculate 工具计算 55*66 并返回结果",
    "请使用 calculate 工具计算 2024-1999 并返回结果"
  ]

  const results: Outcome[] = []
  for (let i = 0; i < TRIALS; i += 1) {
    for (const format of FORMATS) {
      results.push(await runTrial(cookie, format, tasks[i]))
    }
  }

  for (const format of FORMATS) {
    const group = results.filter((result) => result.format === format)
    const firstTry = group.filter((result) => result.attempts === 1).length
    const totalRetries = group.reduce((sum, result) => sum + result.attempts - 1, 0)
    const totalCalls = group.reduce((sum, result) => sum + result.attempts, 0)
    const allFailures = group.flatMap((result) => result.failures)
    const kindCounts = new Map<string, number>()
    for (const kind of allFailures) kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
    const lengthTrunc = group.reduce((sum, result) => sum + result.lengthTruncations, 0)
    const outputChars = group.reduce((sum, result) => sum + result.outputChars, 0)
    const outputTokens = group.reduce((sum, result) => sum + result.outputTokens, 0)
    console.log(`\n=== ${format.toUpperCase()} (n=${group.length}) ===`)
    console.log(`first-try success: ${firstTry}/${group.length}`)
    console.log(`error rate (needs >=1 retry): ${(1 - firstTry / group.length) * 100}%`)
    console.log(`avg attempts per trial: ${(totalCalls / group.length).toFixed(2)}`)
    console.log(`total correction retries: ${totalRetries} (length truncations: ${lengthTrunc})`)
    console.log(`average output chars: ${(outputChars / group.length).toFixed(1)}`)
    console.log(`average output tokens: ${(outputTokens / group.length).toFixed(1)}`)
    console.log(`failure kinds: ${[...kindCounts.entries()].map(([kind, count]) => `${kind}=${count}`).join(", ")}`)
  }
}

void main()
