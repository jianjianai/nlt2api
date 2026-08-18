import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { stringify } from "yaml"
import { AccountPool } from "../../server/v2/accounts/pool"
import { PortalClient } from "../../server/v2/portal/client"
import {
  REQUEST_LOG_MAX_BODY_BYTES,
  REQUEST_LOG_MAX_RECORDS,
  REQUEST_LOG_MAX_TOTAL_BYTES,
  RequestLogService
} from "../../server/v2/request-log/service"
import { ApiError } from "../../server/v2/shared/errors"
import { AccountService, createEmptyV2State, V2StateRepository } from "../../server/v2/state"

async function temporaryRepository(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "neuralwatt-v2-request-log-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "state.yaml")
  return { directory, file, repository: await V2StateRepository.open(file) }
}

function deterministicService(repository: V2StateRepository): RequestLogService {
  let now = Date.parse("2026-08-18T00:00:00.000Z")
  let id = 0
  return new RequestLogService(repository, {
    now: () => now++,
    createId: () => `request_log_${++id}`
  })
}

test("request logging defaults off, persists its switch, and accepts an existing v2 state without the field", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "neuralwatt-v2-request-log-compat-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "state.yaml")
  const existingState = createEmptyV2State() as unknown as Record<string, unknown>
  delete existingState.requestLogging
  await writeFile(file, stringify(existingState), "utf8")

  const repository = await V2StateRepository.open(file)
  const logs = deterministicService(repository)
  assert.equal((await logs.snapshot()).enabled, false)
  assert.equal(await logs.beginClientRequest({ source: "openai", method: "POST", url: "/v1/chat/completions" }), undefined)

  assert.equal(await logs.setEnabled(true), true)
  const restarted = await RequestLogService.open(await V2StateRepository.open(file))
  assert.equal((await restarted.snapshot()).enabled, true)
})

test("request logs correlate upstream attempts and redact credentials without hiding generation settings", async (t) => {
  const { repository } = await temporaryRepository(t)
  const logs = deterministicService(repository)
  await logs.setEnabled(true)
  const requestId = await logs.beginClientRequest({
    source: "openai",
    method: "post",
    url: "/v1/chat/completions?api_key=url-secret&trace=Bearer%20trace-secret",
    headers: {
      authorization: "Bearer inference-secret",
      cookie: "nw_v2_admin=admin-secret",
      "x-api-key": "header-secret",
      "user-agent": "test-client"
    }
  })
  assert.ok(requestId)
  logs.setClientBody(requestId, {
    model: "debug-model",
    max_tokens: 256,
    password: "client-password",
    access_token: "client-token",
    messages: [{ role: "user", content: "Use Bearer embedded-secret and sk-example12345" }]
  })

  const firstAttempt = logs.beginUpstreamRequest(requestId, {
    accountId: "account_one",
    method: "POST",
    url: "https://portal.example/api/chat?token=query-secret",
    headers: { cookie: "session=first-secret", "content-type": "application/json" },
    body: { model: "debug-model", max_tokens: 128, client_secret: "body-secret" }
  })
  const firstResponse = logs.observeUpstreamResponse(requestId, firstAttempt, new Response(JSON.stringify({
    error: { message: "token=upstream-secret" },
    refresh_token: "response-secret"
  }), {
    status: 401,
    headers: { "content-type": "application/json", "set-cookie": "session=rotated-secret" }
  }))
  await firstResponse.text()

  const secondAttempt = logs.beginUpstreamRequest(requestId, {
    accountId: "account_two",
    method: "POST",
    url: "https://portal.example/api/chat",
    headers: { cookie: "session=second-secret", "content-type": "application/json" },
    body: { model: "debug-model", max_tokens: 64 }
  })
  const secondResponse = logs.observeUpstreamResponse(requestId, secondAttempt, new Response(JSON.stringify({
    choices: [{ message: { content: "ok" } }]
  }), { headers: { "content-type": "application/json" } }))
  const successfulBody = JSON.parse(await secondResponse.text())
  logs.finishClientJson(requestId, { body: successfulBody })

  const snapshot = await logs.snapshot()
  assert.equal(snapshot.records.length, 1)
  const record = snapshot.records[0]
  assert.equal(record.source, "openai")
  assert.equal(record.upstream.length, 2)
  assert.deepEqual(record.upstream.map((attempt) => [attempt.sequence, attempt.accountId, attempt.response?.status]), [
    [1, "account_one", 401],
    [2, "account_two", 200]
  ])
  assert.equal((record.client.request.body as { max_tokens: number }).max_tokens, 256)
  assert.equal(record.client.request.headers.authorization, "[REDACTED]")
  assert.equal(record.upstream[0].request.headers.cookie, "[REDACTED]")
  assert.equal(record.upstream[0].response?.headers["set-cookie"], "[REDACTED]")
  const serialized = JSON.stringify(snapshot)
  for (const secret of [
    "url-secret",
    "trace-secret",
    "inference-secret",
    "admin-secret",
    "header-secret",
    "client-password",
    "client-token",
    "embedded-secret",
    "sk-example12345",
    "query-secret",
    "first-secret",
    "body-secret",
    "upstream-secret",
    "response-secret",
    "rotated-secret",
    "second-secret"
  ]) assert.equal(serialized.includes(secret), false, `leaked ${secret}`)
})

test("AccountPool and PortalClient attach account failover attempts to one client request", async (t) => {
  const { repository } = await temporaryRepository(t)
  let accountNumber = 0
  const accounts = new AccountService(repository, {
    createId: () => `account_${String(++accountNumber).padStart(4, "0")}`
  })
  const first = await accounts.createAccount({
    label: "First",
    email: "first@example.com",
    password: "first-password",
    cookie: "session=first-cookie"
  })
  const second = await accounts.createAccount({
    label: "Second",
    email: "second@example.com",
    password: "second-password",
    cookie: "session=second-cookie"
  })
  const logs = deterministicService(repository)
  await logs.setEnabled(true)
  const clientRequestId = await logs.beginClientRequest({
    source: "openai",
    method: "POST",
    url: "/v1/chat/completions"
  })
  const portal = new PortalClient({
    origin: "http://127.0.0.1:4316",
    requestLogs: logs,
    fetch: async (_input, init) => {
      const cookie = new Headers(init?.headers).get("cookie")
      if (cookie === "session=first-cookie") return new Response("rate limited", { status: 429 })
      return new Response(JSON.stringify({ choices: [{ message: { content: "fallback" } }] }), {
        headers: { "content-type": "application/json" }
      })
    }
  })
  const pool = new AccountPool(accounts, portal)
  const exchange = await pool.openChat({ model: "debug-model", stream: false }, { requestLogId: clientRequestId })
  assert.equal(exchange.kind, "json")
  logs.finishClientJson(clientRequestId, { body: exchange.kind === "json" ? exchange.value : {} })

  const record = (await logs.snapshot()).records[0]
  assert.deepEqual(record.upstream.map((attempt) => attempt.accountId), [first.id, second.id])
  assert.deepEqual(record.upstream.map((attempt) => attempt.response?.status), [429, 200])
  assert.ok(record.upstream.every((attempt) => attempt.request.url === "http://127.0.0.1:4316/api/chat"))
  assert.ok(record.upstream.every((attempt) => attempt.request.headers.cookie === "[REDACTED]"))
})

test("stream logging settles complete, cancelled, and failed client streams", async (t) => {
  const { repository } = await temporaryRepository(t)
  const logs = deterministicService(repository)
  await logs.setEnabled(true)

  const completedId = await logs.beginClientRequest({ source: "openai", method: "POST", url: "/complete" })
  const completed = logs.observeClientStream(completedId, new Response("data: done\n\n").body!)
  assert.equal(await new Response(completed).text(), "data: done\n\n")

  const cancelledId = await logs.beginClientRequest({ source: "admin_test", method: "POST", url: "/cancel" })
  let sourceCancelled = false
  const cancelled = logs.observeClientStream(cancelledId, new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("partial"))
    },
    cancel() {
      sourceCancelled = true
    }
  }))
  const cancelledReader = cancelled.getReader()
  await cancelledReader.read()
  await cancelledReader.cancel("client_closed")
  assert.equal(sourceCancelled, true)

  const failedId = await logs.beginClientRequest({ source: "openai", method: "POST", url: "/failed" })
  const failed = logs.observeClientStream(failedId, new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("socket failed with Bearer transport-secret"))
    }
  }))
  await assert.rejects(() => new Response(failed).text(), /transport-secret/)

  const records = (await logs.snapshot()).records
  const completedRecord = records.find((record) => record.id === completedId)
  const cancelledRecord = records.find((record) => record.id === cancelledId)
  const failedRecord = records.find((record) => record.id === failedId)
  assert.equal(completedRecord?.client.result?.outcome, "complete")
  assert.equal(cancelledRecord?.client.result?.outcome, "cancelled")
  assert.equal(failedRecord?.client.result?.outcome, "complete")
  assert.equal(failedRecord?.client.error?.message.includes("transport-secret"), false)
  assert.ok(records.every((record) => record.completedAt !== null && record.durationMs !== null))
})

test("upstream transport errors are recorded without exposing the thrown credential", async (t) => {
  const { repository } = await temporaryRepository(t)
  const logs = deterministicService(repository)
  await logs.setEnabled(true)
  const requestId = await logs.beginClientRequest({ source: "openai", method: "POST", url: "/v1/chat/completions" })
  const attemptId = logs.beginUpstreamRequest(requestId, {
    accountId: "account_one",
    method: "POST",
    url: "https://portal.example/api/chat",
    body: { model: "debug-model" }
  })
  logs.finishUpstreamError(requestId, attemptId, new ApiError("Bearer network-secret failed", {
    status: 502,
    code: "upstream_unreachable"
  }))
  logs.finishClientError(requestId, new ApiError("Portal failed", { status: 502, code: "upstream_unreachable" }))

  const record = (await logs.snapshot()).records[0]
  assert.equal(record.upstream[0].response, null)
  assert.equal(record.upstream[0].error?.code, "upstream_unreachable")
  assert.equal(JSON.stringify(record).includes("network-secret"), false)
})

test("request logs enforce per-body, record-count, and total-memory limits", async (t) => {
  const { repository } = await temporaryRepository(t)
  const logs = deterministicService(repository)
  await logs.setEnabled(true)

  for (let index = 0; index < REQUEST_LOG_MAX_RECORDS + 5; index += 1) {
    const requestId = await logs.beginClientRequest({ source: "openai", method: "POST", url: `/small/${index}` })
    logs.finishClientJson(requestId, { body: { index } })
  }
  let snapshot = await logs.snapshot()
  assert.equal(snapshot.records.length, REQUEST_LOG_MAX_RECORDS)
  assert.equal(snapshot.records.at(-1)?.client.request.url, "/small/5")

  assert.equal(logs.clear(), REQUEST_LOG_MAX_RECORDS)
  const largeValue = "x".repeat(20_000)
  for (let index = 0; index < 140; index += 1) {
    const requestId = await logs.beginClientRequest({ source: "openai", method: "POST", url: `/large/${index}` })
    logs.setClientBody(requestId, { a: largeValue, b: largeValue, c: largeValue, d: largeValue, index })
  }
  snapshot = await logs.snapshot()
  assert.ok(snapshot.records.length < 140)
  assert.ok(snapshot.records.every((record) => record.client.request.bodyTruncated))
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.records), "utf8") <= REQUEST_LOG_MAX_TOTAL_BYTES + 2_000)
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.records[0].client.request.body), "utf8") <= REQUEST_LOG_MAX_BODY_BYTES + 2)
})
