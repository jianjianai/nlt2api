import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AccountPool, type AccountPortalClient } from "../../server/v2/accounts/pool"
import { createAgentStream, normalizePortalStream } from "../../server/v2/openai/response"
import { parseSseJson, SseDecoder } from "../../server/v2/portal/sse"
import { PortalClient, readPortalJson, type PortalCredentials, type PortalSessionResult } from "../../server/v2/portal/client"
import { ApiError } from "../../server/v2/shared/errors"
import type { JsonObject } from "../../server/v2/shared/json"
import { AccountService, V2StateRepository } from "../../server/v2/state"

interface TestState {
  accounts: AccountService
  cleanup(): Promise<void>
}

async function testState(): Promise<TestState> {
  const directory = await mkdtemp(join(tmpdir(), "neuralwatt-v2-integration-"))
  const repository = await V2StateRepository.open(join(directory, "state.yaml"))
  let nextId = 0
  return {
    accounts: new AccountService(repository, {
      createId: () => `account_${String(++nextId).padStart(4, "0")}`
    }),
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

function jsonResponse(value: JsonObject): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" }
  })
}

function sseResponse(chunks: string[], onCancel?: () => void): Response {
  const encoder = new TextEncoder()
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index]))
      index += 1
    },
    cancel() {
      onCancel?.()
    }
  }), {
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  })
}

function portal(overrides: Partial<AccountPortalClient>): AccountPortalClient {
  return {
    login: async (_credentials: PortalCredentials): Promise<PortalSessionResult> => ({
      ok: false,
      status: 401,
      reason: "expired"
    }),
    checkSession: async (): Promise<PortalSessionResult> => ({
      ok: false,
      status: 401,
      reason: "expired"
    }),
    chat: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    ...overrides
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

function decodeSse(text: string): Array<JsonObject | "[DONE]"> {
  const decoder = new SseDecoder()
  return [...decoder.push(text), ...decoder.finish()].map((event) => parseSseJson(event.data))
}

function objectFrame(value: JsonObject | "[DONE]"): JsonObject {
  assert.notEqual(value, "[DONE]")
  if (value === "[DONE]") throw new Error("Expected a JSON SSE frame")
  return value
}

test("AccountPool refreshes one 401 session and persists the replacement cookie", async (t) => {
  const state = await testState()
  t.after(state.cleanup)
  const created = await state.accounts.createAccount({
    label: "Primary",
    email: "primary@example.com",
    password: "portal-password",
    cookie: "session=old"
  })
  const chatCookies: string[] = []
  let loginCount = 0
  const pool = new AccountPool(state.accounts, portal({
    login: async (credentials) => {
      loginCount += 1
      assert.deepEqual(credentials, { email: "primary@example.com", password: "portal-password" })
      return { ok: true, status: 200, cookie: "session=fresh" }
    },
    chat: async (cookie) => {
      chatCookies.push(cookie)
      return cookie === "session=old"
        ? new Response("expired", { status: 401 })
        : jsonResponse({ id: "completion", choices: [{ message: { content: "ready" } }] })
    }
  }))

  const result = await pool.openChat({ stream: false })

  assert.equal(result.kind, "json")
  assert.equal(result.accountId, created.id)
  assert.deepEqual(chatCookies, ["session=old", "session=fresh"])
  assert.equal(loginCount, 1)
  const persisted = await state.accounts.getAccountRecord(created.id)
  assert.equal(persisted.cookie, "session=fresh")
  assert.equal(persisted.status, "ready")
  assert.equal(persisted.lastError, null)
})

test("AccountPool isolates each waiter abort from a shared login flight", async (t) => {
  const state = await testState()
  t.after(state.cleanup)
  await state.accounts.createAccount({
    label: "Concurrent login",
    email: "concurrent@example.com",
    password: "portal-password"
  })
  let announceLogin!: () => void
  const loginStarted = new Promise<void>((resolve) => {
    announceLogin = resolve
  })
  let finishLogin!: (result: PortalSessionResult) => void
  let loginCount = 0
  const pool = new AccountPool(state.accounts, portal({
    login: async (_credentials, signal) => {
      loginCount += 1
      assert.equal(signal, undefined)
      announceLogin()
      return await new Promise<PortalSessionResult>((resolve) => {
        finishLogin = resolve
      })
    },
    chat: async () => jsonResponse({ choices: [{ message: { content: "shared" } }] })
  }))

  const firstAbort = new AbortController()
  const secondAbort = new AbortController()
  const first = pool.openChat({ stream: false }, { signal: firstAbort.signal })
  await loginStarted
  const second = pool.openChat({ stream: false }, { signal: secondAbort.signal })
  await new Promise<void>((resolve) => setImmediate(resolve))
  firstAbort.abort()
  await assert.rejects(first, (error: unknown) => error instanceof Error && error.name === "AbortError")

  finishLogin({ ok: true, status: 200, cookie: "session=shared" })
  const result = await second
  assert.equal(result.kind, "json")
  assert.equal(loginCount, 1)
  assert.equal(secondAbort.signal.aborted, false)
})

test("AccountPool marks a 429 account unavailable and fails over without replaying on it", async (t) => {
  const state = await testState()
  t.after(state.cleanup)
  const first = await state.accounts.createAccount({
    label: "Rate limited",
    email: "limited@example.com",
    password: "password-one",
    cookie: "session=limited"
  })
  const second = await state.accounts.createAccount({
    label: "Available",
    email: "available@example.com",
    password: "password-two",
    cookie: "session=available"
  })
  const chatCookies: string[] = []
  const pool = new AccountPool(state.accounts, portal({
    chat: async (cookie) => {
      chatCookies.push(cookie)
      if (cookie === "session=limited") return new Response("slow down", { status: 429 })
      return jsonResponse({ choices: [{ message: { content: "fallback" } }] })
    }
  }))

  const result = await pool.openChat({ stream: false })

  assert.equal(result.kind, "json")
  assert.equal(result.accountId, second.id)
  assert.deepEqual(chatCookies, ["session=limited", "session=available"])
  const limited = await state.accounts.getAccountRecord(first.id)
  assert.equal(limited.status, "temporarily_unavailable")
  assert.equal(limited.lastError, "rate_limited")
  assert.equal((await state.accounts.getAccountRecord(second.id)).status, "ready")
})

test("AccountPool preflights an embedded stream auth error, refreshes, and replays the valid first event", async (t) => {
  const state = await testState()
  t.after(state.cleanup)
  const created = await state.accounts.createAccount({
    label: "Streaming",
    email: "stream@example.com",
    password: "stream-password",
    cookie: "session=expired"
  })
  let loginCount = 0
  const pool = new AccountPool(state.accounts, portal({
    login: async () => {
      loginCount += 1
      return { ok: true, status: 200, cookie: "session=stream-fresh" }
    },
    chat: async (cookie) => {
      if (cookie === "session=expired") {
        return sseResponse([
          "data: {\"error\":{\"message\":\"session expired; sign in again\"}}\n\n"
        ])
      }
      return sseResponse([
        ": heartbeat\n\n",
        "data: {\"id\":\"portal-stream\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hel",
        "lo\"},\"finish_reason\":null}]}\n\n",
        "data: [DONE]\n\n"
      ])
    }
  }))

  const result = await pool.openChat({ stream: true })

  assert.equal(result.kind, "stream")
  assert.equal(result.accountId, created.id)
  assert.equal(loginCount, 1)
  const replayed = await result.response.text()
  assert.match(replayed, /^: heartbeat\n\ndata: /)
  assert.match(replayed, /\"content\":\"hello\"/)
  assert.match(replayed, /data: \[DONE\]\n\n$/)
  assert.equal((await state.accounts.getAccountRecord(created.id)).cookie, "session=stream-fresh")
})

test("normalizePortalStream preserves the first frame identity and emits usage immediately before DONE", async () => {
  const upstream = sseResponse([
    "data: {\"id\":\"chatcmpl-upstream\",\"created\":123,\"model\":\"portal-model\",\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3,\"private_field\":99}}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DO",
    "NE]\n\n"
  ])
  const frames = decodeSse(await readText(normalizePortalStream(upstream.body, "requested-model", true)))

  assert.equal(frames.length, 5)
  const first = objectFrame(frames[0])
  const content = objectFrame(frames[1])
  const finished = objectFrame(frames[2])
  const usage = objectFrame(frames[3])
  assert.deepEqual(first, {
    id: "chatcmpl-upstream",
    created: 123,
    model: "portal-model",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant" }, logprobs: null, finish_reason: null }],
    usage: null
  })
  assert.deepEqual(content.choices, [{
    index: 0,
    delta: { content: "hello" },
    logprobs: null,
    finish_reason: null
  }])
  assert.deepEqual(finished.choices, [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }])
  assert.deepEqual(usage.choices, [])
  assert.deepEqual(usage.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 })
  assert.equal(frames[4], "[DONE]")
})

test("normalizePortalStream emits stable OpenAI errors for upstream errors and missing DONE", async () => {
  const failed = decodeSse(await readText(normalizePortalStream(sseResponse([
    "data: {\"error\":{\"message\":\"portal failure\"}}\n\n",
    "data: [DONE]\n\n"
  ]).body, "model-a", false)))
  assert.equal(failed.length, 1)
  assert.deepEqual(objectFrame(failed[0]).error, {
    message: "portal failure",
    type: "server_error",
    param: null,
    code: "upstream_stream_error"
  })

  const truncated = decodeSse(await readText(normalizePortalStream(sseResponse([
    "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n"
  ]).body, "model-b", false)))
  assert.equal(truncated.length, 2)
  assert.deepEqual(objectFrame(truncated[1]).error, {
    message: "The NeuralWatt portal stream ended before data: [DONE]",
    type: "server_error",
    param: null,
    code: "truncated_upstream_stream"
  })
})

test("normalizePortalStream converts transport failures and forwards a terminal event without a blank line", async () => {
  const encoder = new TextEncoder()
  let pullCount = 0
  const brokenBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount += 1
      if (pullCount === 1) {
        controller.enqueue(encoder.encode(
          "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n"
        ))
        return
      }
      controller.error(new Error("socket reset"))
    }
  })
  const brokenFrames = decodeSse(await readText(normalizePortalStream(brokenBody, "model-c", false)))
  assert.equal(brokenFrames.length, 2)
  assert.equal(objectFrame(brokenFrames[0]).choices instanceof Array, true)
  assert.deepEqual(objectFrame(brokenFrames[1]).error, {
    message: "The NeuralWatt portal stream failed after it started",
    type: "server_error",
    param: null,
    code: "upstream_stream_error"
  })

  const eofDoneFrames = decodeSse(await readText(normalizePortalStream(sseResponse([
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]"
  ]).body, "model-d", false)))
  assert.equal(eofDoneFrames.length, 2)
  assert.equal(objectFrame(eofDoneFrames[0]).choices instanceof Array, true)
  assert.equal(eofDoneFrames[1], "[DONE]")
})

test("portal body timeouts remain 504 errors before JSON and SSE responses are committed", async (t) => {
  const state = await testState()
  t.after(state.cleanup)
  await state.accounts.createAccount({
    label: "Timeout",
    email: "timeout@example.com",
    password: "portal-password",
    cookie: "session=timeout"
  })
  const client = new PortalClient({
    origin: "http://127.0.0.1:4399",
    chatTimeoutMs: 20,
    fetch: async (_input, init) => {
      const signal = init?.signal
      const accept = new Headers(init?.headers).get("accept") ?? "application/json"
      let keepAlive: ReturnType<typeof setTimeout> | undefined
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          keepAlive = setTimeout(() => {}, 1_000)
          const fail = (): void => {
            if (keepAlive) clearTimeout(keepAlive)
            controller.error(signal?.reason ?? new DOMException("Timed out", "TimeoutError"))
          }
          if (signal?.aborted) fail()
          else signal?.addEventListener("abort", fail, { once: true })
        },
        cancel() {
          if (keepAlive) clearTimeout(keepAlive)
        }
      }), { headers: { "content-type": accept } })
    }
  })
  const pool = new AccountPool(state.accounts, client)
  const isTimeout = (error: unknown): boolean => error instanceof ApiError
    && error.status === 504
    && error.code === "upstream_timeout"

  await assert.rejects(() => pool.openChat({ stream: false }), isTimeout)
  await assert.rejects(() => pool.openChat({ stream: true }), isTimeout)
})

test("createAgentStream closes promptly when its external signal aborts", async () => {
  const abort = new AbortController()
  let modelSignal: AbortSignal | undefined
  const stream = createAgentStream({
    model: "agent-model",
    includeUsage: false,
    signal: abort.signal,
    run: ({ signal }) => {
      modelSignal = signal
      return new Promise(() => {})
    }
  })
  const reader = stream.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  abort.abort("client_disconnected")
  const ended = await reader.read()
  assert.equal(ended.done, true)
  assert.equal(modelSignal?.aborted, true)
})

test("malformed upstream JSON and SSE are normalized before a response is committed", async (t) => {
  await assert.rejects(
    () => readPortalJson(new Response("not-json", { headers: { "content-type": "application/json" } })),
    (error: unknown) => error instanceof ApiError && error.status === 502 && error.code === "invalid_upstream_json"
  )

  const state = await testState()
  t.after(state.cleanup)
  await state.accounts.createAccount({
    label: "Malformed stream",
    email: "malformed@example.com",
    password: "portal-password",
    cookie: "session=valid"
  })
  let canceled = false
  const malformedStream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: not-json\n\n"))
    },
    cancel() {
      canceled = true
    }
  }), { headers: { "content-type": "text/event-stream" } })
  const pool = new AccountPool(state.accounts, portal({
    chat: async () => malformedStream
  }))
  await assert.rejects(
    () => pool.openChat({ stream: true }),
    (error: unknown) => error instanceof ApiError && error.status === 502 && error.code === "invalid_upstream_sse"
  )
  assert.equal(canceled, true)
})
