import { HttpError } from "~/server/utils/http.ts";
import { ProxyTransportError } from "~/server/utils/proxy.ts";
import { UpstreamError } from "~/server/utils/upstream-http.ts";

/**
 * Maps any thrown value onto the HttpError the API contract expects. Lives apart
 * from http.ts to keep that module free of the upstream/proxy import cycle.
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ProxyTransportError) {
    return new HttpError(502, error.message, "server_error", undefined, "proxy_transport_error");
  }
  if (error instanceof UpstreamError) {
    const code = error.kind === "captcha"
      ? "captcha_rejected"
      : error.kind === "rate_limit"
        ? "rate_limit_exceeded"
        : error.kind === "ip_blocked"
          ? "egress_blocked"
          : error.kind === "model_capacity"
            ? "model_busy"
            : "upstream_error";
    return new HttpError(error.status, error.message, "server_error", undefined, code, error.retryAfterSeconds);
  }
  return new HttpError(500, "Internal gateway error.", "server_error");
}
