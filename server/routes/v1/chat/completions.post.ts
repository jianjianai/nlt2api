import { defineEventHandler, getResponseStatus, readBody, readRawBody, sendStream, setResponseHeader } from "h3"
import { createDebugTrace, type DebugTrace } from "../../../utils/debug"
import { requireProxyAuth } from "../../../utils/auth"
import { sendOpenAIError } from "../../../utils/errors"
import { handleChatRequest } from "../../../utils/proxy"

export default defineEventHandler(async (event) => {
  let trace: DebugTrace | undefined
  try {
    await requireProxyAuth(event)
    trace = await createDebugTrace()
    const rawBody = await readRawBody(event)
    await trace?.recordText("client-request", rawBody ?? "", {
      content_type: event.node.req.headers["content-type"] ?? null
    })
    const body = await readBody<unknown>(event)
    const result = await handleChatRequest(body, trace)

    if (result.kind === "stream") {
      setResponseHeader(event, "content-type", "text/event-stream; charset=utf-8")
      setResponseHeader(event, "cache-control", "no-cache, no-transform")
      setResponseHeader(event, "connection", "keep-alive")
      return sendStream(event, trace ? trace.captureStream("client-response", result.body, {
        stream: true,
        http_status: getResponseStatus(event)
      }) : result.body)
    }

    setResponseHeader(event, "content-type", "application/json; charset=utf-8")
    await trace?.recordText("client-response", JSON.stringify(result.body), {
      stream: false,
      http_status: getResponseStatus(event)
    })
    return result.body
  } catch (error) {
    const response = sendOpenAIError(event, error)
    await trace?.recordText("client-response", JSON.stringify(response), {
      stream: false,
      error: true,
      http_status: getResponseStatus(event)
    })
    return response
  }
})
