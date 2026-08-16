import { defineEventHandler, readBody, sendStream, setResponseHeader } from "h3"
import { requireProxyAuth } from "../../../utils/auth"
import { sendOpenAIError } from "../../../utils/errors"
import { handleChatRequest } from "../../../utils/proxy"

export default defineEventHandler(async (event) => {
  try {
    await requireProxyAuth(event)
    const body = await readBody<unknown>(event)
    const result = await handleChatRequest(body)

    if (result.kind === "stream") {
      setResponseHeader(event, "content-type", "text/event-stream; charset=utf-8")
      setResponseHeader(event, "cache-control", "no-cache, no-transform")
      setResponseHeader(event, "connection", "keep-alive")
      return sendStream(event, result.body)
    }

    setResponseHeader(event, "content-type", "application/json; charset=utf-8")
    return result.body
  } catch (error) {
    return sendOpenAIError(event, error)
  }
})
