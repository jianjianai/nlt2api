import type { JsonObject, JsonValue } from "~/server/utils/types.ts";

export function redact(value: JsonValue | Record<string, unknown> | undefined): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value as JsonObject | undefined;
  }
  return redactObject(value as Record<string, unknown>);
}

function redactObject(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = "[redacted]";
    } else if (Array.isArray(item)) {
      result[key] = item.map((entry) => redactValue(entry));
    } else {
      result[key] = redactValue(item);
    }
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return new Set([
    "authorization",
    "proxy_authorization",
    "cookie",
    "set_cookie",
    "password",
    "current_password",
    "new_password",
    "session",
    "session_cookie",
    "nw_session",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "x_api_key",
    "csrf",
    "csrf_token",
    "client_secret",
  ]).has(normalized);
}

function redactValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return String(value);
}
