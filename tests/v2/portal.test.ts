import assert from "node:assert/strict"
import test from "node:test"
import { PortalClient } from "../../server/v2/portal/client"
import { parseSseJson, SseDecoder } from "../../server/v2/portal/sse"

test("SseDecoder accepts arbitrary boundaries, comments, CRLF, and multiline data", () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push(": pricing\r\nda"), [])
  assert.deepEqual(decoder.push("ta: {\"a\":\r\ndata: 1}\r\n\r\n"), [{ data: "{\"a\":\n1}" }])
  assert.deepEqual(decoder.push("event: done\nid: 7\ndata: [DONE]"), [])
  assert.deepEqual(decoder.finish(), [{ event: "done", id: "7", data: "[DONE]" }])
  assert.equal(parseSseJson("[DONE]"), "[DONE]")
  assert.deepEqual(parseSseJson("{\"ok\":true}"), { ok: true })
})

test("SseDecoder rejects non-object JSON payloads", () => {
  assert.throws(() => parseSseJson("[]"), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "invalid_upstream_sse"
  })
})

test("checkSession requires the expected JSON shape and does not follow redirects", async () => {
  const requests: Array<RequestInfo | URL> = []
  const client = new PortalClient({
    origin: "http://127.0.0.1:4311",
    fetch: async (input) => {
      requests.push(input)
      return new Response("<html>login</html>", {
        status: 302,
        headers: { location: "/login", "content-type": "text/html" }
      })
    }
  })
  const result = await client.checkSession("session=value")
  assert.deepEqual(result, { ok: false, status: 302, reason: "challenge" })
  assert.equal(requests.length, 1)
})

test("checkSession accepts only a usage response and reports rotated cookies", async () => {
  const client = new PortalClient({
    origin: "http://127.0.0.1:4312",
    fetch: async () => new Response(JSON.stringify({ rate_limited: false }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "session=rotated; Path=/; HttpOnly"
      }
    })
  })
  assert.deepEqual(await client.checkSession("session=old"), {
    ok: true,
    status: 200,
    cookie: "session=rotated"
  })
})

test("login validates the issued cookie with the usage endpoint", async () => {
  const calls: string[] = []
  const client = new PortalClient({
    origin: "http://127.0.0.1:4313",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/auth/login")) {
        return new Response(null, {
          status: 302,
          headers: { "set-cookie": "session=one; Path=/; HttpOnly", location: "/" }
        })
      }
      return new Response(JSON.stringify({ rate_limited: false }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "session=two; Path=/; HttpOnly"
        }
      })
    }
  })
  const result = await client.login({ email: "test@example.com", password: "not-logged" })
  assert.equal(result.ok, true)
  assert.equal(result.cookie, "session=two")
  assert.equal(calls.length, 2)
})

test("PortalClient rejects insecure non-loopback origins", () => {
  assert.throws(() => new PortalClient({ origin: "http://example.com" }), /must use HTTPS/)
})

test("modelCatalog validates response size and shape", async () => {
  const valid = new PortalClient({
    origin: "http://127.0.0.1:4314",
    modelCatalogUrl: "http://127.0.0.1:4314/v1/models",
    fetch: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "model" }] }), {
      headers: { "content-type": "application/json", "x-models-scope": "public" }
    })
  })
  const catalog = await valid.modelCatalog()
  assert.equal(catalog.scope, "public")
  assert.deepEqual(catalog.body.data, [{ id: "model" }])

  const oversized = new PortalClient({
    origin: "http://127.0.0.1:4315",
    modelCatalogUrl: "http://127.0.0.1:4315/v1/models",
    maximumJsonBytes: 8,
    fetch: async () => new Response(JSON.stringify({ object: "list", data: [] }), {
      headers: { "content-type": "application/json" }
    })
  })
  await assert.rejects(() => oversized.modelCatalog(), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "upstream_response_too_large"
  })
})
