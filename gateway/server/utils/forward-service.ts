import { HttpError } from "~/server/utils/http.ts";
import { ProxyTransportError } from "~/server/utils/proxy.ts";
import type { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { TicketPoolService } from "~/server/utils/ticket-pool.ts";
import { chatCompletions, modelCatalog, type UpstreamModel } from "~/server/utils/upstream.ts";
import { UpstreamError } from "~/server/utils/upstream-http.ts";
import type { JsonObject } from "~/server/utils/types.ts";

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

function poolExhausted(): HttpError {
  return new HttpError(
    503,
    "No usable proxy/ticket pair is available. The authorization service is still replenishing the pool.",
    "server_error",
    undefined,
    "ticket_pool_empty",
    5,
  );
}

export interface ForwardDependencies {
  settings: SettingsStore;
  proxies: ProxyPoolService;
  tickets: TicketPoolService;
  chat?: typeof chatCompletions;
  catalog?: typeof modelCatalog;
}

export class ForwardService {
  private modelsCache: { at: number; models: UpstreamModel[] } | undefined;

  constructor(private readonly dependencies: ForwardDependencies) {}

  /**
   * Forwards one chat request. Each attempt spends a distinct (proxy, ticket)
   * pair: the ticket is single-use upstream, so a retry must never reuse it.
   */
  async chat(request: JsonObject, signal?: AbortSignal): Promise<Response> {
    const { settings, proxies, tickets } = this.dependencies;
    const chat = this.dependencies.chat ?? chatCompletions;
    const config = settings.get();
    let lastError: unknown;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const pair = tickets.claim();
      if (!pair) {
        // Surface why the previous attempt failed rather than masking a real
        // upstream/proxy error behind "the pool is empty".
        if (lastError) throw lastError;
        throw poolExhausted();
      }
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
        return response;
      } catch (error) {
        // The pair is spent either way: upstream redeems the ticket on success
        // and on captcha rejection, and a half-used one cannot be trusted.
        tickets.drop(pair.ticket.id);
        if (error instanceof ProxyTransportError) {
          proxies.markFailure(pair.ticket.proxyId, error.message);
        }
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
    const models = await catalog({
      timeoutMs: config.upstreamTimeoutMs,
      ...(proxy ? { proxyUrl: proxy.url } : {}),
      ...(signal ? { signal } : {}),
    });
    this.modelsCache = { at: now, models };
    return models;
  }

  invalidateModelsCache(): void {
    this.modelsCache = undefined;
  }
}
