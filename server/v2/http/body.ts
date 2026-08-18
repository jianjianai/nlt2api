import { readRawBody, type H3Event } from "h3"
import { invalidRequest } from "../shared/errors"
import { MAX_REQUEST_BYTES } from "../shared/limits"

export async function readJsonBody(event: H3Event, maximumBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const raw = await readRawBody(event, false)
  if (raw === undefined || raw === null || raw.length === 0) {
    throw invalidRequest("The request body must be a JSON object", "invalid_request")
  }
  const size = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength
  if (size > maximumBytes) {
    throw invalidRequest("The request body exceeds the size limit", "request_too_large")
  }
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"))
  } catch {
    throw invalidRequest("The request body is not valid JSON", "invalid_json")
  }
}
