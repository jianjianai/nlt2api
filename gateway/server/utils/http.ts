import { timingSafeEqual } from "node:crypto";
import { getGatewayConfig } from "~/server/utils/config.ts";
import type { JsonObject, JsonValue } from "~/server/utils/types.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | undefined;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    message: string,
    type = "invalid_request_error",
    param?: string,
    code?: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
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

export function openAIErrorResponse(error: unknown): Response {
  const known = error instanceof HttpError ? error : new HttpError(500, "Internal gateway error.", "server_error");
  const retryAfter = typeof known.retryAfterSeconds === "number" && Number.isFinite(known.retryAfterSeconds) && known.retryAfterSeconds > 0
    ? Math.ceil(known.retryAfterSeconds)
    : undefined;
  return jsonResponse({
    error: {
      message: known.message,
      type: known.type,
      ...(known.param ? { param: known.param } : {}),
      ...(known.code ? { code: known.code } : {}),
    },
  }, known.status, retryAfter ? { "Retry-After": String(retryAfter) } : undefined);
}

async function readBodyText(request: Request, maxBytes: number, limitHint: string): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `Request body is too large (limit ${maxBytes} bytes; raise ${limitHint}).`);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, `Request body is too large (limit ${maxBytes} bytes; raise ${limitHint}).`);
      }
      chunks.push(value);
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
  return new TextDecoder().decode(bytes);
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
  const text = await readBodyText(request, getGatewayConfig().maxRequestBytes, "GATEWAY_MAX_REQUEST_BYTES");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body as JsonObject;
}

export async function readTextBody(request: Request): Promise<string> {
  return readBodyText(request, getGatewayConfig().maxImportBytes, "GATEWAY_MAX_IMPORT_BYTES");
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || undefined;
  }
  return request.headers.get("x-api-key")?.trim() || undefined;
}

export function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Client credential check for /v1/*. An empty GATEWAY_API_KEY rejects every
 * request rather than opening the endpoint; GATEWAY_ALLOW_ANONYMOUS=true is the
 * only way to serve unauthenticated traffic.
 */
export function requireClientAuth(request: Request): void {
  const config = getGatewayConfig();
  const received = bearerToken(request);
  if (received) {
    if (config.apiKey && secureEquals(received, config.apiKey)) return;
    if (config.allowAnonymous) return;
    throw new HttpError(401, "Invalid API key.", "authentication_error", undefined, "invalid_api_key");
  }
  if (config.allowAnonymous) return;
  if (!config.apiKey) {
    throw new HttpError(503, "GATEWAY_API_KEY is not configured.", "server_error", undefined, "api_key_not_configured");
  }
  throw new HttpError(401, "Invalid API key.", "authentication_error", undefined, "invalid_api_key");
}

export function requireAdminAuth(request: Request): void {
  const expected = getGatewayConfig().adminToken;
  if (!expected) {
    throw new HttpError(503, "GATEWAY_ADMIN_TOKEN is not configured.", "server_error", undefined, "admin_not_configured");
  }
  const received = request.headers.get("x-admin-token")?.trim() || bearerToken(request);
  if (!received || !secureEquals(received, expected)) {
    throw new HttpError(401, "Invalid admin token.", "authentication_error", undefined, "invalid_admin_token");
  }
}

export function asString(value: unknown, field: string, options?: { optional?: boolean; maxLength?: number }): string | undefined {
  if (value === undefined || value === null) {
    if (options?.optional) return undefined;
    throw new HttpError(400, `\`${field}\` is required.`, "invalid_request_error", field);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `\`${field}\` must be a non-empty string.`, "invalid_request_error", field);
  }
  if (options?.maxLength && value.length > options.maxLength) {
    throw new HttpError(400, `\`${field}\` is too long.`, "invalid_request_error", field);
  }
  return value;
}

export function asInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `\`${field}\` must be an integer from ${min} through ${max}.`, "invalid_request_error", field);
  }
  return value;
}
