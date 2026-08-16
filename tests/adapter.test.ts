import assert from "node:assert/strict"
import test from "node:test"
import { AppError } from "../server/utils/errors"
import { validateChatRequest } from "../server/utils/openai"
import { createSseRelay, normalizeCompletion, prepareSse } from "../server/utils/response"

test("maps max_completion_tokens to the portal max_tokens field", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hello" }],
    max_completion_tokens: 32,
    stream: false
  })

  assert.equal(result.portalPayload.max_tokens, 32)
  assert.equal(result.portalPayload.max_completion_tokens, undefined)
})

test("maps historical assistant reasoning_content to the portal reasoning field", () => {
  const result = validateChatRequest({
    model: "kimi-k3",
    messages: [{ role: "assistant", content: "TEST_OK", reasoning_content: "prior reasoning" }]
  })

  const message = (result.portalPayload.messages as Array<Record<string, unknown>>)[0]
  assert.equal(message.reasoning, "prior reasoning")
  assert.equal(message.reasoning_content, undefined)
})

test("rejects unsupported tool calls with an OpenAI parameter error", () => {
  assert.throws(
    () => validateChatRequest({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup" } }]
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400 && error.param === "tools"
  )
})

test("normalizes a non-streaming provider response", () => {
  const result = normalizeCompletion({
    id: "provider-id",
    model: "kimi-k3",
    choices: [{ index: 0, message: { role: "assistant", content: "TEST_OK", reasoning: "legacy reasoning", reasoning_content: "canonical reasoning" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    energy: { joules: 1 }
  }, "kimi-k3")

  assert.equal(result.object, "chat.completion")
  assert.equal((result.choices as Array<Record<string, unknown>>)[0].message && ((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).content, "TEST_OK")
  assert.equal(((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).reasoning_content, "canonical reasoning")
  assert.equal(((result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>).reasoning, undefined)
  assert.equal(result.energy, undefined)
})

test("normalizes SSE, preserves reasoning, and removes provider comments and optional usage", async () => {
  const upstream = new Response([
    ": pricing {\"input\":1}\n\n",
    "data: {\"id\":\"chunk-1\",\"model\":\"kimi-k3\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning\":\"first thought\",\"content\":\"TEST_OK\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chunk-1\",\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
    "data: [DONE]\n\n"
  ].join(""))
  const prepared = await prepareSse(upstream.body)
  assert.equal(prepared.firstError, undefined)
  const relay = createSseRelay(prepared, "kimi-k3", false)
  const text = await new Response(relay).text()

  assert.match(text, /data: \{/) 
  assert.match(text, /TEST_OK/)
  assert.match(text, /\"reasoning_content\":\"first thought\"/)
  assert.doesNotMatch(text, /\"reasoning\":/)
  assert.doesNotMatch(text, /pricing/)
  assert.doesNotMatch(text, /prompt_tokens/)
  assert.match(text, /data: \[DONE\]/)
})
