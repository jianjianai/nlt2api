import { defineEventHandler, sendStream, setResponseHeader } from "h3"
import { getRuntime } from "../../../v2/runtime"
import { readJsonBody } from "../../../v2/http/body"
import { requireInferenceKey } from "../../../v2/http/auth"
import { sendApiError } from "../../../v2/http/errors"
import type { RequestLogService } from "../../../v2/request-log/service"

export default defineEventHandler(async (event) => {
  const abort = new AbortController()
  event.node.req.once("aborted", () => abort.abort("client_request_aborted"))
  event.node.res.once("close", () => {
    if (!event.node.res.writableEnded) abort.abort("client_response_closed")
  })
  let requestLogs: RequestLogService | undefined
  let requestLogId: string | undefined
  try {
    const runtime = await getRuntime()
    requestLogs = runtime.requestLogs
    await requireInferenceKey(event, runtime)
    requestLogId = await requestLogs.beginClientRequest({
      source: "openai",
      method: event.node.req.method ?? "POST",
      url: event.node.req.url ?? "/v1/chat/completions",
      headers: event.node.req.headers
    })
    const input = await readJsonBody(event)
    requestLogs.setClientBody(requestLogId, input)
    const result = await runtime.chat.handle(input, { signal: abort.signal, requestLogId })
    if (result.kind === "stream") {
      setResponseHeader(event, "content-type", "text/event-stream; charset=utf-8")
      setResponseHeader(event, "cache-control", "no-cache, no-transform")
      setResponseHeader(event, "connection", "keep-alive")
      setResponseHeader(event, "x-accel-buffering", "no")
      const body = requestLogs.observeClientStream(requestLogId, result.body, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        }
      })
      return sendStream(event, body)
    }
    setResponseHeader(event, "content-type", "application/json; charset=utf-8")
    requestLogs.finishClientJson(requestLogId, {
      headers: { "content-type": "application/json; charset=utf-8" },
      body: result.body
    })
    return result.body
  } catch (error) {
    requestLogs?.finishClientError(requestLogId, error)
    return sendApiError(event, error)
  }
})
