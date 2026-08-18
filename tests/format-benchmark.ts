import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import YAML from "yaml"
import { runAgentLoop, type AgentMessage } from "../server/utils/agent-loop"
import { validateChatRequest } from "../server/utils/openai"

const TRIALS = 12
const MODEL = "kimi-k3"
const TOOL_NAME = "calculate"
const MAX_TOKENS = 1024

interface Outcome {
  attempts: number
  corrections: number
  failed: boolean
  outputChars: number
}

async function portalChat(cookie: string, messages: AgentMessage[]): Promise<{ content: string; reasoning?: string }> {
  const origin = process.env.NEURALWATT_PORTAL_ORIGIN || "https://portal.neuralwatt.com"
  const response = await fetch(origin + "/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie },
    body: JSON.stringify({ model: MODEL, messages, stream: false, max_tokens: MAX_TOKENS })
  })
  if (!response.ok) throw new Error("portal status=" + response.status)
  const value = await response.json() as { choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }> }
  const message = value.choices?.[0]?.message
  return {
    content: typeof message?.content === "string" ? message.content : "",
    ...(typeof message?.reasoning === "string" ? { reasoning: message.reasoning } : {})
  }
}

async function runTrial(cookie: string, task: string): Promise<Outcome> {
  const request = validateChatRequest({
    model: MODEL,
    messages: [{ role: "user", content: task }],
    tools: [{ type: "function", function: { name: TOOL_NAME, parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } } }],
    tool_choice: "required",
    parallel_tool_calls: false,
    stream: false
  })
  const outputs: string[] = []
  let attempts = 0
  try {
    await runAgentLoop({
      baseMessages: request.portalPayload.messages as AgentMessage[],
      toolPlan: request.toolPlan,
      requestModel: async (messages) => {
        attempts += 1
        const output = await portalChat(cookie, messages)
        outputs.push(output.content)
        return output
      }
    })
    return { attempts, corrections: Math.max(0, attempts - 1), failed: false, outputChars: outputs.reduce((sum, value) => sum + value.length, 0) }
  } catch {
    return { attempts, corrections: Math.max(0, attempts - 1), failed: true, outputChars: outputs.reduce((sum, value) => sum + value.length, 0) }
  }
}

async function main(): Promise<void> {
  const store = YAML.parse(readFileSync(resolve(process.cwd(), ".data", "neuralwatt-accounts.yaml"), "utf8")) as { accounts?: Array<{ cookie?: string }> }
  const cookie = store.accounts?.[0]?.cookie
  if (!cookie) throw new Error("no stored cookie")
  const results: Outcome[] = []
  for (let index = 0; index < TRIALS; index += 1) {
    results.push(await runTrial(cookie, "请使用 calculate 工具计算 " + (index + 2) + "*" + (index + 3) + " 并返回结果"))
  }
  const attempts = results.reduce((sum, result) => sum + result.attempts, 0)
  const corrections = results.reduce((sum, result) => sum + result.corrections, 0)
  console.log(JSON.stringify({ trials: results.length, firstTry: results.filter((result) => result.attempts === 1).length, averageAttempts: attempts / results.length, totalCorrections: corrections, failed: results.filter((result) => result.failed).length, averageOutputChars: results.reduce((sum, result) => sum + result.outputChars, 0) / results.length }, null, 2))
}

void main()
