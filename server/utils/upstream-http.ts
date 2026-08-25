import { fetch as undiciFetch, type Dispatcher } from "undici";
import { getProxyConfig } from "~/server/utils/config.ts";
import { asProxyTransportError, ProxyTransportError } from "~/server/utils/proxy.ts";
import type { JsonObject } from "~/server/utils/types.ts";

type UpstreamFetchInit = RequestInit & { dispatcher?: Dispatcher };
const compatibleFetch = undiciFetch as unknown as (
  input: string,
  init?: UpstreamFetchInit,
) => Promise<Response>;
const responseFinishes = new WeakMap<Response, () => void>();

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
    readonly payload?: JsonObject,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export function upstreamResponseBodyTimeoutError(): UpstreamError {
  return new UpstreamError("DeepInfra timed out while waiting for response data.", 504);
}

function clientAbortError(): UpstreamError {
  return new UpstreamError("The client disconnected before the DeepInfra response completed.", 499);
}

export async function upstreamFetch(
  input: string,
  init: RequestInit,
  clientSignal?: AbortSignal,
  dispatcher?: Dispatcher,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let clientAborted = false;
  const clearTimeoutTimer = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  };
  const armTimeout = () => {
    clearTimeoutTimer();
    timedOut = false;
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, getProxyConfig().upstreamTimeoutMs);
  };
  const abortForClient = () => {
    clientAborted = true;
    controller.abort();
  };
  if (clientSignal?.aborted) abortForClient();
  else clientSignal?.addEventListener("abort", abortForClient, { once: true });
  const finish = () => {
    clearTimeoutTimer();
    clientSignal?.removeEventListener("abort", abortForClient);
  };

  armTimeout();
  try {
    const response = await compatibleFetch(input, {
      ...init,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    clearTimeoutTimer();
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
          armTimeout();
          const chunk = await reader.read();
          clearTimeoutTimer();
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
          else if (timedOut) streamController.error(upstreamResponseBodyTimeoutError());
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
        : new UpstreamError("DeepInfra timed out while waiting for response headers.", 504);
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

async function readUpstreamText(response: Response): Promise<string> {
  const maxBytes = getProxyConfig().maxUpstreamBytes;
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await discardUpstreamResponse(response);
    throw new UpstreamError("The DeepInfra response exceeded the adapter limit.", 502);
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
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new UpstreamError("The DeepInfra response exceeded the adapter limit.", 502);
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new UpstreamError("The DeepInfra response timed out.", 504);
    }
    throw error;
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

export interface UpstreamJsonBody {
  raw: string;
  value?: unknown;
  valid: boolean;
}

export async function readUpstreamJsonBody(response: Response): Promise<UpstreamJsonBody> {
  const body = await readUpstreamText(response);
  try {
    return { raw: body, value: JSON.parse(body), valid: true };
  } catch {
    return { raw: body, valid: false };
  }
}

export function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const parsed = Number(value.trim());
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 86_400);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const seconds = (timestamp - Date.now()) / 1_000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86_400) : undefined;
}
