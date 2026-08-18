import { invalidRequest } from "../shared/errors"
import { isJsonObject, type JsonObject } from "../shared/json"

export function objectBody(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw invalidRequest("The request body must be a JSON object", "invalid_request")
  return value
}

export function allowKeys(value: JsonObject, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidRequest(`${key} is not allowed`, "unknown_parameter", key)
  }
}

export function expectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidRequest("revision must be a positive integer", "invalid_revision", "revision")
  }
  return value
}
