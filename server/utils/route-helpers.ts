import { randomUUID } from "node:crypto";
import { HttpError } from "~/server/utils/http.ts";
import { redact } from "~/server/utils/redaction.ts";
import { PortalError } from "~/server/utils/portal-client.ts";
import { requestCause } from "~/server/utils/request-errors.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import type { DebugRawBody, DebugRecord, DebugUpstreamCall, JsonObject } from "~/server/utils/types.ts";

export function upstreamHttpError(error: unknown): HttpError {
  error = requestCause(error);
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof PortalError) {
    if (error.status === 400 || error.status === 404 || error.status === 422) {
      return new HttpError(error.status, "The NeuralWatt portal rejected the requested model or parameters.", "invalid_request_error");
    }
    if (error.status === 429) {
      return new HttpError(429, "The selected portal account is rate limited.", "rate_limit_error", undefined, "rate_limit_exceeded");
    }
    return new HttpError(502, "The NeuralWatt portal could not complete the request.", "api_error", undefined, "upstream_error");
  }
  return new HttpError(500, "Internal proxy error.", "server_error");
}

export function adminHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof PortalError) {
    return upstreamHttpError(error);
  }
  return new HttpError(
    400,
    error instanceof Error ? error.message : "The admin request could not be completed.",
    "invalid_request_error",
  );
}

function redactJsonBody(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return body;
    }
    const serialized = JSON.stringify(parsed);
    const redacted = JSON.stringify(redact(parsed as Record<string, unknown>) ?? {});
    return serialized === redacted ? body : redacted;
  } catch {
    return body;
  }
}

function redactSseBody(body: string): string {
  return body.replace(/^(data:\s*)(.+)$/gm, (line, prefix: string, data: string) => {
    if (data === "[DONE]") return line;
    return `${prefix}${redactJsonBody(data)}`;
  });
}

function redactRawBody(body: DebugRawBody): DebugRawBody {
  return {
    ...body,
    body: body.contentType === "application/json"
      ? redactJsonBody(body.body)
      : body.contentType === "text/event-stream"
        ? redactSseBody(body.body)
        : body.body,
  };
}

function redactUpstreamCall(call: DebugUpstreamCall): DebugUpstreamCall {
  return {
    ...call,
    request: redactRawBody(call.request),
    ...(call.response ? { response: redactRawBody(call.response) } : {}),
  };
}

export async function recordDebug(input: Omit<DebugRecord, "id" | "at">): Promise<void> {
  try {
    await stateStore.appendDebugRecord({
      id: `dbg_${randomUUID().replaceAll("-", "")}`,
      at: new Date().toISOString(),
      ...input,
      clientRequest: redactRawBody(input.clientRequest),
      ...(input.clientResponse ? { clientResponse: redactRawBody(input.clientResponse) } : {}),
      ...(input.upstreamCalls ? { upstreamCalls: input.upstreamCalls.map(redactUpstreamCall) } : {}),
    });
  } catch {
    // Diagnostics must never turn a completed model request into an error.
  }
}

export function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
