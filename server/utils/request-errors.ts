import type { JsonObject, ToolCallAdapterTrace } from "~/server/utils/types.ts";

export interface RequestDebugContext {
  accountId?: string;
  accountLabel?: string;
  upstreamRequest?: JsonObject;
  upstreamResponse?: JsonObject;
  toolCallAdapter?: ToolCallAdapterTrace;
}

export class ProxyRequestError extends Error {
  constructor(readonly originalError: unknown, readonly debugContext: RequestDebugContext) {
    super(originalError instanceof Error ? originalError.message : "The proxy request failed.");
    this.name = "ProxyRequestError";
  }
}

export function requestDebugContext(error: unknown): RequestDebugContext {
  return error instanceof ProxyRequestError ? error.debugContext : {};
}

export function requestCause(error: unknown): unknown {
  return error instanceof ProxyRequestError ? error.originalError : error;
}
