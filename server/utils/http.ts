import { timingSafeEqual } from "node:crypto";
import { getProxyConfig } from "~/server/utils/config.ts";
import { redact } from "~/server/utils/redaction.ts";
import type { JsonObject, JsonValue } from "~/server/utils/types.ts";

export { redact } from "~/server/utils/redaction.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | undefined;
  readonly code: string | undefined;

  constructor(
    status: number,
    message: string,
    type = "invalid_request_error",
    param?: string,
    code?: string,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export function openAIErrorResponse(error: unknown): Response {
  const known = error instanceof HttpError
    ? error
    : new HttpError(500, "Internal proxy error.", "server_error");
  const retryAfterSeconds = "retryAfterSeconds" in known
    && typeof known.retryAfterSeconds === "number"
    && Number.isFinite(known.retryAfterSeconds)
    && known.retryAfterSeconds > 0
    ? Math.ceil(known.retryAfterSeconds)
    : undefined;
  return jsonResponse({
    error: {
      message: known.message,
      type: known.type,
      ...(known.param ? { param: known.param } : {}),
      ...(known.code ? { code: known.code } : {}),
    },
  }, known.status, retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : undefined);
}

export function jsonResponse(body: JsonValue | Record<string, unknown>, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export interface ReadJsonObjectResult {
  body: JsonObject;
  raw: string;
}

export async function readJsonObjectWithRaw(request: Request): Promise<ReadJsonObjectResult> {
  const maxBytes = getProxyConfig().maxRequestBytes;
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, `Request body is too large (limit ${maxBytes} bytes; raise NEURALWATT_MAX_REQUEST_BYTES).`, "invalid_request_error");
  }

  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new HttpError(413, `Request body is too large (limit ${maxBytes} bytes; raise NEURALWATT_MAX_REQUEST_BYTES).`, "invalid_request_error");
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(bytes);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return { body: body as JsonObject, raw: text };
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
  return (await readJsonObjectWithRaw(request)).body;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return request.headers.get("x-api-key")?.trim() || undefined;
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function requireClientAuth(request: Request): void {
  const expected = getProxyConfig().apiKey;
  if (!expected) {
    if (getProxyConfig().allowAnonymous) {
      return;
    }
    throw new HttpError(503, "NEURALWATT_API_KEY is not configured.", "server_error", undefined, "api_key_not_configured");
  }
  const received = bearerToken(request);
  if (!received || !secureEquals(received, expected)) {
    throw new HttpError(401, "Invalid API key.", "authentication_error", undefined, "invalid_api_key");
  }
}

export function requireAdminAuth(request: Request): void {
  const expected = getProxyConfig().adminToken;
  if (!expected) {
    throw new HttpError(503, "NEURALWATT_ADMIN_TOKEN is not configured.", "server_error", undefined, "admin_not_configured");
  }
  const received = request.headers.get("x-admin-token")?.trim() || bearerToken(request);
  if (!received || !secureEquals(received, expected)) {
    throw new HttpError(401, "Invalid admin token.", "authentication_error", undefined, "invalid_admin_token");
  }
}

export function asString(value: unknown, field: string, options?: { optional?: boolean; maxLength?: number; allowEmpty?: boolean }): string | undefined {
  if (value === undefined || value === null) {
    if (options?.optional) {
      return undefined;
    }
    throw new HttpError(400, `\`${field}\` is required.`, "invalid_request_error", field);
  }
  if (typeof value !== "string" || (!options?.allowEmpty && !value.trim())) {
    throw new HttpError(400, `\`${field}\` must be a non-empty string.`, "invalid_request_error", field);
  }
  if (options?.maxLength && value.length > options.maxLength) {
    throw new HttpError(400, `\`${field}\` is too long.`, "invalid_request_error", field);
  }
  return value;
}

export function asBoolean(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new HttpError(400, `\`${field}\` is required.`, "invalid_request_error", field);
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, `\`${field}\` must be a boolean.`, "invalid_request_error", field);
  }
  return value;
}

export function asNumber(value: unknown, field: string, options?: { optional?: boolean; min?: number; max?: number }): number | undefined {
  if (value === undefined || value === null) {
    if (options?.optional) {
      return undefined;
    }
    throw new HttpError(400, `\`${field}\` is required.`, "invalid_request_error", field);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `\`${field}\` must be a number.`, "invalid_request_error", field);
  }
  if ((options?.min !== undefined && value < options.min) || (options?.max !== undefined && value > options.max)) {
    throw new HttpError(400, `\`${field}\` is outside the supported range.`, "invalid_request_error", field);
  }
  return value;
}
