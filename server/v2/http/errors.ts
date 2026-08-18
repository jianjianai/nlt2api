import { getResponseStatus, setResponseHeader, setResponseStatus, type H3Event } from "h3"
import { asApiError, openAIErrorBody } from "../shared/errors"

export function sendApiError(event: H3Event, error: unknown): Record<string, unknown> {
  const apiError = asApiError(error)
  setResponseStatus(event, apiError.status)
  setResponseHeader(event, "content-type", "application/json; charset=utf-8")
  setResponseHeader(event, "cache-control", "no-store")
  if (apiError.retryAfterSeconds !== undefined) {
    setResponseHeader(event, "retry-after", apiError.retryAfterSeconds)
  }
  if (apiError.status >= 500) {
    console.error(`[error] code=${apiError.code} status=${getResponseStatus(event)}`)
  }
  return openAIErrorBody(apiError)
}
