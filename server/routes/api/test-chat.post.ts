import { defineEventHandler, sendStream, setResponseHeader } from "h3"
import { requireAdmin } from "../../v2/http/auth"
import { readJsonBody } from "../../v2/http/body"
import { sendApiError } from "../../v2/http/errors"
import { getRuntime } from "../../v2/runtime"

export default defineEventHandler(async (event) => {
  const abort = new AbortController()
  event.node.req.once("aborted", () => abort.abort("client_request_aborted"))
  event.node.res.once("close", () => {
    if (!event.node.res.writableEnded) abort.abort("client_response_closed")
  })
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const result = await runtime.chat.handle(await readJsonBody(event), { signal: abort.signal })
    if (result.kind === "stream") {
      setResponseHeader(event, "content-type", "text/event-stream; charset=utf-8")
      setResponseHeader(event, "cache-control", "no-cache, no-transform")
      setResponseHeader(event, "connection", "keep-alive")
      return sendStream(event, result.body)
    }
    setResponseHeader(event, "content-type", "application/json; charset=utf-8")
    return result.body
  } catch (error) {
    return sendApiError(event, error)
  }
})
