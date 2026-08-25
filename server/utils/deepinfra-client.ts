import { type Dispatcher } from "undici";
import { deepInfraTurnstileMinter, TurnstileMintError, type TurnstileTicket } from "~/server/utils/deepinfra-turnstile.ts";
import { proxyDispatcher, ProxyTransportError } from "~/server/utils/proxy.ts";
import {
  discardUpstreamResponse,
  retryAfterSeconds,
  upstreamFetch,
  UpstreamError,
} from "~/server/utils/upstream-http.ts";
import {
  MAX_UPSTREAM_CHAT_ATTEMPTS,
  retryableUpstreamError,
  retryableUpstreamStatus,
  upstreamRetryDelayMs,
} from "~/server/utils/upstream-retry.ts";
import type { JsonObject, ManagedAccount } from "~/server/utils/types.ts";

/**
 * Anonymous DeepInfra web upstream. The request shape mirrors the model demo page:
 * OpenAI-compatible Chat Completions with no Bearer credential, authorized instead by
 * a freshly minted single-use Cloudflare Turnstile ticket.
 */

const API_ORIGIN = "https://api.deepinfra.com";
const CHAT_URL = `${API_ORIGIN}/v1/openai/chat/completions`;
const MODELS_URL = `${API_ORIGIN}/models/list`;
const WEB_ORIGIN = "https://deepinfra.com";
/** Tag DeepInfra applies to models excluded from the free anonymous tier. */
const PAID_ONLY_TAG = "no-free-anon";

/**
 * The account's egress proxy. Verified upstream behaviour: a Turnstile ticket is NOT
 * bound to the IP that minted it, so one shared minter can serve every egress and the
 * chat request may leave through a different exit than the challenge did.
 */
function egressDispatcher(proxy?: string): Dispatcher | undefined {
  return proxy ? proxyDispatcher(proxy) : undefined;
}

export interface DeepInfraModel {
  id: string;
  contextLength?: number;
  freeForAnonymous: boolean;
}

function requestHeaders(ticket: TurnstileTicket, stream: boolean): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/`,
    "X-DeepInfra-Turnstile": ticket.token,
    "X-Deepinfra-Source": ticket.source,
    accept: stream ? "text/event-stream" : "application/json",
    ...(ticket.userAgent ? { "User-Agent": ticket.userAgent } : {}),
  };
}

function retryAfterFromPayload(payload: JsonObject | undefined): number | undefined {
  const error = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as JsonObject
    : undefined;
  const value = error?.retry_after ?? payload?.retry_after;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, 86_400) : undefined;
}

const MODEL_CAPACITY_PATTERN = /(?:model\s+busy|busy,?\s+retry\s+later|concurrenc(?:y|ies)|slots?\s+in\s+use)/i;

export function deepInfraUpstreamError(status: number, body: string, retryAfter?: number): UpstreamError {
  let message = body.slice(0, 300);
  let payload: JsonObject | undefined;
  try {
    const parsed = JSON.parse(body) as JsonObject;
    payload = parsed;
    const error = parsed.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      message = error.message;
    } else if (typeof parsed.detail === "string") {
      message = parsed.detail;
    }
  } catch {
    // Non-JSON upstream body; the truncated text is the most useful message available.
  }
  const kind = MODEL_CAPACITY_PATTERN.test(message) || MODEL_CAPACITY_PATTERN.test(body)
    ? "model_capacity"
    : status === 429
      ? "rate_limit"
      : "upstream";
  return new UpstreamError(`DeepInfra upstream failed: ${message}`, status, retryAfter ?? retryAfterFromPayload(payload), payload, kind);
}

/**
 * Sends one chat request to the anonymous DeepInfra upstream.
 *
 * A ticket is minted per call and never reused: DeepInfra redeems it server-side, so a
 * second request with the same ticket returns 403 `Captcha verification failed`.
 */
export async function probeDeepInfraChat(proxy?: string, signal?: AbortSignal): Promise<void> {
  const response = await deepInfraChat({
    model: "moonshotai/Kimi-K3",
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 4,
    stream: false,
  }, signal, proxy);
  try {
    const body = await response.json() as { choices?: unknown[]; error?: unknown };
    if (!Array.isArray(body.choices) || body.choices.length === 0 || body.error !== undefined) {
      throw new UpstreamError("DeepInfra proxy smoke test returned an invalid completion.", 502);
    }
  } finally {
    await discardUpstreamResponse(response).catch(() => undefined);
  }
}

export async function probeDeepInfraProxy(proxy?: string, signal?: AbortSignal): Promise<void> {
  if (proxy) await checkDeepInfraProxy(proxy, signal);
  else await deepInfraCatalog(signal);
  await probeDeepInfraChat(proxy, signal);
}

export interface DeepInfraChatRetry {
  status: number;
  contentType: string;
  body: string;
  error?: string;
}

export async function deepInfraChat(
  request: JsonObject,
  signal?: AbortSignal,
  proxy?: string,
  onRetry?: (attempt: DeepInfraChatRetry) => void | Promise<void>,
  beforeRetryAttempt?: () => void | Promise<void>,
): Promise<Response> {
  const stream = request.stream === true;
  const dispatcher = egressDispatcher(proxy);
  for (let attempt = 1; attempt <= MAX_UPSTREAM_CHAT_ATTEMPTS; attempt += 1) {
    let ticket: TurnstileTicket;
    try {
      // A ticket is single-use, so every physical retry MUST mint a new one.
      ticket = await deepInfraTurnstileMinter().mint();
    } catch (error) {
      if (error instanceof TurnstileMintError) {
        throw new UpstreamError(`DeepInfra challenge unavailable (${error.reason}).`, 503, undefined, undefined, "challenge");
      }
      throw error;
    }

    let response: Response;
    try {
      response = await upstreamFetch(CHAT_URL, {
        method: "POST",
        headers: requestHeaders(ticket, stream),
        body: JSON.stringify(request),
      }, signal, dispatcher);
    } catch (error) {
      if (signal?.aborted || error instanceof UpstreamError && error.status === 499) throw error;
      if (attempt >= MAX_UPSTREAM_CHAT_ATTEMPTS || !retryableUpstreamError(error)) throw error;
      await onRetry?.({
        status: 0,
        contentType: "",
        body: "",
        error: error instanceof Error ? error.message : "Unknown DeepInfra transport error.",
      });
      await new Promise((resolve) => setTimeout(resolve, upstreamRetryDelayMs(attempt)));
      await beforeRetryAttempt?.();
      continue;
    }

    if (retryableUpstreamStatus(response.status) && attempt < MAX_UPSTREAM_CHAT_ATTEMPTS) {
      const body = await response.text();
      await onRetry?.({
        status: response.status,
        contentType: response.headers.get("content-type")?.toLowerCase() ?? "",
        body,
      });
      const delayMs = (retryAfterSeconds(response) ?? upstreamRetryDelayMs(attempt) / 1_000) * 1_000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await beforeRetryAttempt?.();
      continue;
    }

    if (!response.ok) {
      throw deepInfraUpstreamError(response.status, await response.text(), retryAfterSeconds(response));
    }
    return response;
  }
  throw new UpstreamError("DeepInfra exhausted its retry budget.", 502);
}

/**
 * Reads the public model catalog. Needs no ticket and no credential, but goes through
 * the account's egress so account creation fails fast when that egress cannot reach
 * DeepInfra at all (for example an IPv6-only exit, since DeepInfra publishes no AAAA).
 */
export async function deepInfraCatalog(signal?: AbortSignal, proxy?: string): Promise<Array<Record<string, unknown>>> {
  const response = await upstreamFetch(MODELS_URL, {}, signal, egressDispatcher(proxy));
  if (!response.ok) {
    throw deepInfraUpstreamError(response.status, await response.text(), retryAfterSeconds(response));
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
}

export function classifyDeepInfraModels(entries: Array<Record<string, unknown>>): DeepInfraModel[] {
  return entries.flatMap((entry) => {
    const id = typeof entry.model_name === "string" ? entry.model_name : undefined;
    if (!id || entry.reported_type !== "text-generation") return [];
    const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const featured = tags.includes("featured");
    return [{
      id,
      freeForAnonymous: featured && !tags.includes(PAID_ONLY_TAG),
      ...(typeof entry.max_tokens === "number" ? { contextLength: entry.max_tokens } : {}),
    }];
  });
}

export async function deepInfraModels(signal?: AbortSignal, proxy?: string): Promise<DeepInfraModel[]> {
  return classifyDeepInfraModels(await deepInfraCatalog(signal, proxy));
}

export async function verifyDeepInfraAccount(account: ManagedAccount, signal?: AbortSignal): Promise<void> {
  await deepInfraClient.probeProxy(account.proxy, signal);
}

export async function listDeepInfraAccountModels(account: ManagedAccount, signal?: AbortSignal): Promise<string[]> {
  return (await deepInfraModels(signal, account.proxy))
    .filter((model) => model.freeForAnonymous)
    .map((model) => model.id);
}

export async function checkDeepInfraProxy(proxy: string, signal?: AbortSignal): Promise<void> {
  const response = await upstreamFetch(MODELS_URL, {}, signal, proxyDispatcher(proxy));
  if (!response.ok) {
    throw deepInfraUpstreamError(response.status, await response.text(), retryAfterSeconds(response));
  }
  await discardUpstreamResponse(response);
}

/** Single DeepInfra upstream facade and test injection boundary. */
export const deepInfraClient = {
  chat: deepInfraChat,
  catalog: deepInfraCatalog,
  models: deepInfraModels,
  verifyAccount: verifyDeepInfraAccount,
  listAccountModels: listDeepInfraAccountModels,
  checkProxy: checkDeepInfraProxy,
  probeChat: probeDeepInfraChat,
  probeProxy: probeDeepInfraProxy,
};
