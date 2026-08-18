import { randomUUID } from "node:crypto";
import { HttpError, redact } from "~/server/utils/http.ts";
import { PortalError } from "~/server/utils/portal-client.ts";
import { requestCause } from "~/server/utils/request-errors.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import type { DebugRecord, JsonObject } from "~/server/utils/types.ts";

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

export async function recordDebug(input: Omit<DebugRecord, "id" | "at">): Promise<void> {
  try {
    await stateStore.appendDebugRecord({
      id: `dbg_${randomUUID().replaceAll("-", "")}`,
      at: new Date().toISOString(),
      ...input,
      clientRequest: redact(input.clientRequest) ?? {},
      ...(input.upstreamRequest ? { upstreamRequest: redact(input.upstreamRequest) ?? {} } : {}),
      ...(input.clientResponse ? { clientResponse: redact(input.clientResponse) ?? {} } : {}),
      ...(input.upstreamResponse ? { upstreamResponse: redact(input.upstreamResponse) ?? {} } : {}),
    });
  } catch {
    // Diagnostics must never turn a completed model request into an error.
  }
}

export function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
