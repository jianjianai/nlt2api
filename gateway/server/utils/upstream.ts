import { proxyDispatcher } from "~/server/utils/proxy.ts";
import {
  discardUpstreamResponse,
  readUpstreamBytes,
  readUpstreamText,
  retryAfterSeconds,
  UpstreamError,
  upstreamFetch,
  type UpstreamFailureKind,
} from "~/server/utils/upstream-http.ts";
import type { JsonObject, TicketRecord } from "~/server/utils/types.ts";

const API_ORIGIN = "https://api.deepinfra.com";
const CHAT_URL = `${API_ORIGIN}/v1/openai/chat/completions`;
const MODELS_URL = `${API_ORIGIN}/models/list`;
const WEB_ORIGIN = "https://deepinfra.com";
/** Tag the upstream applies to models excluded from the free anonymous tier. */
const PAID_ONLY_TAG = "no-free-anon";

const MODEL_CAPACITY_PATTERN = /(?:model\s+busy|busy,?\s+retry\s+later|concurrenc(?:y|ies)|slots?\s+in\s+use)/i;
const CAPTCHA_PATTERN = /captcha|turnstile/i;

function retryAfterFromPayload(payload: JsonObject | undefined): number | undefined {
  const error = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as JsonObject
    : undefined;
  const value = error?.retry_after ?? payload?.retry_after;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, 86_400) : undefined;
}

export function upstreamErrorFrom(status: number, body: string, retryAfter?: number): UpstreamError {
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
    // Non-JSON upstream body; the truncated text is the best message available.
  }
  // A 403 that does not mention the challenge is the upstream refusing the
  // egress itself ("Not authenticated"), not a bad ticket: the IP must rest.
  const kind: UpstreamFailureKind = status === 403 && CAPTCHA_PATTERN.test(`${message} ${body}`)
    ? "captcha"
    : status === 403 || status === 401
      ? "ip_blocked"
      : MODEL_CAPACITY_PATTERN.test(message) || MODEL_CAPACITY_PATTERN.test(body)
        ? "model_capacity"
        : status === 429
          ? "rate_limit"
          : "upstream";
  return new UpstreamError(`Upstream failed: ${message}`, status, retryAfter ?? retryAfterFromPayload(payload), payload, kind);
}

export interface ChatUpstreamOptions {
  request: JsonObject;
  ticket: TicketRecord;
  proxyUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

function chatHeaders(ticket: TicketRecord, stream: boolean): Record<string, string> {
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

/**
 * One chat attempt. The ticket and the proxy must be the pair they were minted
 * as: the credential is spent on the same egress that solved the challenge.
 */
export async function chatCompletions(options: ChatUpstreamOptions): Promise<Response> {
  const stream = options.request.stream === true;
  const response = await upstreamFetch(CHAT_URL, {
    method: "POST",
    headers: chatHeaders(options.ticket, stream),
    body: JSON.stringify(options.request),
  }, {
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    dispatcher: proxyDispatcher(options.proxyUrl),
  });
  if (!response.ok) {
    throw upstreamErrorFrom(response.status, await readUpstreamText(response), retryAfterSeconds(response));
  }
  return response;
}

export interface UpstreamModel {
  id: string;
  contextLength?: number;
  freeForAnonymous: boolean;
}

export function classifyModels(entries: Array<Record<string, unknown>>): UpstreamModel[] {
  return entries.flatMap((entry) => {
    const id = typeof entry.model_name === "string" ? entry.model_name : undefined;
    if (!id || entry.reported_type !== "text-generation") return [];
    const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
    return [{
      id,
      freeForAnonymous: tags.includes("featured") && !tags.includes(PAID_ONLY_TAG),
      ...(typeof entry.max_tokens === "number" ? { contextLength: entry.max_tokens } : {}),
    }];
  });
}

export interface CatalogOptions {
  proxyUrl?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Reads the public model catalog. Needs no ticket and no credential. */
export async function modelCatalog(options: CatalogOptions): Promise<UpstreamModel[]> {
  const response = await upstreamFetch(MODELS_URL, {}, {
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.proxyUrl ? { dispatcher: proxyDispatcher(options.proxyUrl) } : {}),
  });
  if (!response.ok) {
    throw upstreamErrorFrom(response.status, await readUpstreamText(response), retryAfterSeconds(response));
  }
  const payload = JSON.parse(await readUpstreamText(response)) as unknown;
  const entries = Array.isArray(payload)
    ? payload.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  return classifyModels(entries);
}

export interface ProxyProbeResult {
  latencyMs: number;
  /** Download speed measured from the probe transfer, in bits per second. */
  throughputBps: number;
}

/** Probes a proxy by fetching the catalog through it, measuring latency and speed. */
export async function probeProxy(proxyUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<ProxyProbeResult> {
  const startedAt = Date.now();
  const response = await upstreamFetch(MODELS_URL, {}, {
    timeoutMs,
    ...(signal ? { signal } : {}),
    dispatcher: proxyDispatcher(proxyUrl),
  });
  if (!response.ok) {
    throw upstreamErrorFrom(response.status, await readUpstreamText(response), retryAfterSeconds(response));
  }
  const { bytes } = await readUpstreamBytes(response);
  const elapsedMs = Date.now() - startedAt;
  return {
    latencyMs: elapsedMs,
    throughputBps: elapsedMs > 0 ? Math.round((bytes * 8 * 1_000) / elapsedMs) : 0,
  };
}
