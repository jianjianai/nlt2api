import { fetch as undiciFetch, type Dispatcher } from "undici";
import { getGatewayConfig } from "~/server/utils/config.ts";
import { asProxyTransportError, ProxyTransportError } from "~/server/utils/proxy.ts";
import type { JsonObject } from "~/server/utils/types.ts";

type UpstreamFetchInit = RequestInit & { dispatcher?: Dispatcher };
const compatibleFetch = undiciFetch as unknown as (input: string, init?: UpstreamFetchInit) => Promise<Response>;
const responseFinishes = new WeakMap<Response, () => void>();

export type UpstreamFailureKind = "captcha" | "rate_limit" | "ip_blocked" | "model_capacity" | "upstream";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
    readonly payload?: JsonObject,
    readonly kind: UpstreamFailureKind = status === 429 ? "rate_limit" : "upstream",
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function clientAbortError(): UpstreamError {
  return new UpstreamError("The client disconnected before the upstream response completed.", 499);
}

export interface UpstreamFetchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  dispatcher?: Dispatcher;
}

/**
 * Fetches an upstream URL with an inactivity timeout that is re-armed on every
 * body chunk, so a long stream stays alive while a stalled one still aborts.
 */
export async function upstreamFetch(input: string, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> {
  const { timeoutMs, signal: clientSignal, dispatcher } = options;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let clientAborted = false;
  const clearTimer = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  };
  const armTimer = () => {
    clearTimer();
    timedOut = false;
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  const abortForClient = () => {
    clientAborted = true;
    controller.abort();
  };
  if (clientSignal?.aborted) abortForClient();
  else clientSignal?.addEventListener("abort", abortForClient, { once: true });
  const finish = () => {
    clearTimer();
    clientSignal?.removeEventListener("abort", abortForClient);
  };

  armTimer();
  try {
    const response = await compatibleFetch(input, {
      ...init,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    clearTimer();
    if (dispatcher && response.status === 407) {
      await discardUpstreamResponse(response);
      throw new ProxyTransportError("Proxy authentication failed.");
    }
    if (!response.body) {
      finish();
      return response;
    }

    const reader = response.body.getReader();
    let bodyFinished = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          armTimer();
          const chunk = await reader.read();
          clearTimer();
          if (chunk.done) {
            bodyFinished = true;
            finish();
            streamController.close();
            return;
          }
          if (chunk.value) streamController.enqueue(chunk.value);
        } catch (error) {
          bodyFinished = true;
          finish();
          if (clientAborted || clientSignal?.aborted) streamController.error(clientAbortError());
          else if (timedOut) streamController.error(new UpstreamError("Upstream timed out while streaming the response.", 504));
          else streamController.error(dispatcher ? asProxyTransportError(error) : error);
        }
      },
      async cancel(reason) {
        if (bodyFinished) return;
        bodyFinished = true;
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    responseFinishes.set(wrapped, finish);
    return wrapped;
  } catch (error) {
    finish();
    if (error instanceof Error && error.name === "AbortError") {
      if (clientAborted || clientSignal?.aborted) throw clientAbortError();
      throw dispatcher
        ? new ProxyTransportError("Proxy request timed out while waiting for response headers.", { cause: error })
        : new UpstreamError("Upstream timed out while waiting for response headers.", 504);
    }
    throw dispatcher ? asProxyTransportError(error) : error;
  }
}

export function finishUpstreamResponse(response: Response): void {
  responseFinishes.get(response)?.();
  responseFinishes.delete(response);
}

export async function discardUpstreamResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A completed or failed response may already be closed.
  } finally {
    finishUpstreamResponse(response);
  }
}

export async function readUpstreamText(response: Response): Promise<string> {
  const maxBytes = getGatewayConfig().maxUpstreamBytes;
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardUpstreamResponse(response);
    throw new UpstreamError("The upstream response exceeded the gateway limit.", 502);
  }
  if (!response.body) {
    finishUpstreamResponse(response);
    return "";
  }

  const reader = response.body.getReader();
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
        throw new UpstreamError("The upstream response exceeded the gateway limit.", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    finishUpstreamResponse(response);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(numeric, 86_400);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(86_400, Math.ceil((date - Date.now()) / 1_000)));
}
