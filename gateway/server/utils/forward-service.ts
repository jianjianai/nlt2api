import { HttpError } from "~/server/utils/http.ts";
import { conversationKey, type SessionAffinity } from "~/server/utils/affinity.ts";
import type { DemandTracker } from "~/server/utils/demand.ts";
import type { ErrorLogService } from "~/server/utils/error-log.ts";
import { ProxyTransportError } from "~/server/utils/proxy.ts";
import type { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { TicketPoolService } from "~/server/utils/ticket-pool.ts";
import { poolExhausted, type TicketQueue } from "~/server/utils/ticket-queue.ts";
import { chatCompletions, modelCatalog, type UpstreamModel } from "~/server/utils/upstream.ts";
import { UpstreamError } from "~/server/utils/upstream-http.ts";
import type { JsonObject, TicketPair } from "~/server/utils/types.ts";

const MAX_MESSAGES = 10_000;

export function validateChatRequest(body: JsonObject): { model: string; stream: boolean } {
  const model = body.model;
  if (typeof model !== "string" || !model.trim()) {
    throw new HttpError(400, "`model` must be a non-empty string.", "invalid_request_error", "model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "`messages` must be a non-empty array.", "invalid_request_error", "messages");
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw new HttpError(400, `\`messages\` must contain at most ${MAX_MESSAGES} entries.`, "invalid_request_error", "messages");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new HttpError(400, "`stream` must be a boolean.", "invalid_request_error", "stream");
  }
  return { model, stream: body.stream === true };
}

export interface ForwardDependencies {
  settings: SettingsStore;
  proxies: ProxyPoolService;
  tickets: TicketPoolService;
  queue: TicketQueue;
  demand: DemandTracker;
  affinity: SessionAffinity;
  /** Optional error journal; forwarding failures land here. */
  errors?: ErrorLogService;
  now?: () => number;
  chat?: typeof chatCompletions;
  catalog?: typeof modelCatalog;
}

export class ForwardService {
  private modelsCache: { at: number; models: UpstreamModel[] } | undefined;

  constructor(private readonly dependencies: ForwardDependencies) {}

  /** One journal row for a failed forward request or attempt. */
  private recordFailure(message: string, options: { proxyId?: string; attempt?: number } = {}): void {
    this.dependencies.errors?.record({
      at: (this.dependencies.now ?? Date.now)(),
      kind: "forward",
      status: "failed",
      message,
      ...options,
    });
  }

  /**
   * Forwards one chat request. Each attempt spends a distinct (proxy, ticket)
   * pair: the ticket is single-use upstream, so a retry must never reuse it.
   * A continuation of a known conversation prefers the egress it started on;
   * a new one takes whichever egress has been idle longest.
   */
  async chat(request: JsonObject, signal?: AbortSignal, sessionId?: string): Promise<Response> {
    const { settings, proxies, tickets, queue, demand, affinity } = this.dependencies;
    const chat = this.dependencies.chat ?? chatCompletions;
    const config = settings.get();
    demand.touch();
    const key = conversationKey(request, sessionId);
    let lastError: unknown;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const prefer = affinity.resolve(key);
      let pair: TicketPair | undefined;
      try {
        if (attempt === 1) {
          pair = await queue.acquire(signal, prefer);
        } else {
          // A retry takes a free pair or gives up with the error that caused it;
          // queueing again would let one client wait the timeout several times over.
          pair = queue.tryClaim(prefer);
          if (!pair) throw lastError ?? poolExhausted();
        }
      } catch (error) {
        // The request failed before any attempt ran: pool empty, queue full,
        // queue timeout or the client leaving. Every failure is journaled, except
        // a retry rethrowing the error its failed attempt already recorded.
        if (attempt === 1 || error !== lastError) {
          this.recordFailure(
            error instanceof Error ? error.message : "No usable credential pair.",
            { attempt },
          );
        }
        throw error;
      }
      demand.record();
      try {
        const response = await chat({
          request,
          ticket: pair.ticket,
          proxyUrl: pair.proxyUrl,
          timeoutMs: config.upstreamTimeoutMs,
          ...(signal ? { signal } : {}),
        });
        // Upstream redeemed the ticket; a replay would return 403.
        tickets.drop(pair.ticket.id);
        affinity.remember(key, pair.ticket.proxyId);
        return response;
      } catch (error) {
        // The pair is spent either way: upstream redeems the ticket on success
        // and on captcha rejection, and a half-used one cannot be trusted.
        tickets.drop(pair.ticket.id);
        if (error instanceof UpstreamError && (error.kind === "rate_limit" || error.kind === "ip_blocked")) {
          // The refusal belongs to the egress IP, not to this request: park that
          // IP and drop the pin so the retry lands somewhere else. An outright
          // 403 means the IP itself is refused, which takes far longer to clear
          // than a rate-limit window.
          const blocked = error.kind === "ip_blocked";
          const fallback = blocked ? config.ipBlockCooldownSeconds : config.rateLimitCooldownSeconds;
          proxies.markCooldown(
            pair.ticket.proxyId,
            (blocked ? fallback : error.retryAfterSeconds ?? fallback) * 1_000,
            blocked ? "ip_blocked" : "rate_limit",
          );
          affinity.forget(key);
        } else if (error instanceof ProxyTransportError) {
          proxies.markFailure(pair.ticket.proxyId, error.message);
          affinity.forget(key);
        }
        // Every failure is journaled: upstream refusals, transport errors and
        // client aborts alike, so the trace shows the full attempt history.
        this.recordFailure(error instanceof Error ? error.message : "Upstream request failed.", {
          proxyId: pair.ticket.proxyId,
          attempt,
        });
        if (signal?.aborted) throw error;
        if (error instanceof UpstreamError && error.status === 499) throw error;
        if (!this.retryable(error) || attempt >= config.maxAttempts) throw error;
        lastError = error;
      }
    }
    throw lastError ?? poolExhausted();
  }

  private retryable(error: unknown): boolean {
    if (error instanceof ProxyTransportError) return true;
    if (!(error instanceof UpstreamError)) return false;
    if (error.kind === "captcha") return true;
    // The egress is now parked, so a retry gets a different IP and may succeed.
    if (error.kind === "ip_blocked") return true;
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599);
  }

  async models(signal?: AbortSignal): Promise<UpstreamModel[]> {
    const { settings, proxies } = this.dependencies;
    const catalog = this.dependencies.catalog ?? modelCatalog;
    const config = settings.get();
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCache.at < config.modelsCacheSeconds * 1_000) {
      return this.modelsCache.models;
    }
    const proxy = proxies.anyActive();
    try {
      const models = await catalog({
        timeoutMs: config.upstreamTimeoutMs,
        ...(proxy ? { proxyUrl: proxy.url } : {}),
        ...(signal ? { signal } : {}),
      });
      this.modelsCache = { at: now, models };
      return models;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : "Model catalog request failed.", proxy ? { proxyId: proxy.id } : {});
      throw error;
    }
  }

  invalidateModelsCache(): void {
    this.modelsCache = undefined;
  }
}
