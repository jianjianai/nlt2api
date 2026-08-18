import { randomUUID } from "node:crypto"
import { runAgentProtocol, type AgentProtocolResult } from "../agent/protocol"
import { AccountPool, type PortalChatExchange } from "../accounts/pool"
import { parseChatCompletionRequest, type ChatMessage, type ParsedChatCompletionRequest } from "../openai/contract"
import {
  completionFromAgent,
  createAgentStream,
  normalizePortalCompletion,
  normalizePortalStream,
  portalCompletionToAgentOutput
} from "../openai/response"
import { ApiError } from "../shared/errors"
import { cloneJson, type JsonObject } from "../shared/json"
import type { SettingsService } from "../state/settings"

export type ChatServiceResult =
  | { kind: "json"; body: JsonObject }
  | { kind: "stream"; body: ReadableStream<Uint8Array> }

export interface HandleChatOptions {
  signal?: AbortSignal
}

export class ChatService {
  private readonly pool: AccountPool
  private readonly settings: SettingsService

  constructor(pool: AccountPool, settings: SettingsService) {
    this.pool = pool
    this.settings = settings
  }

  async handle(input: unknown, options: HandleChatOptions = {}): Promise<ChatServiceResult> {
    const request = parseChatCompletionRequest(input)
    await this.applyDefaults(request)
    const usesAgent = Boolean(request.toolPlan && request.toolPlan.choice !== "none")
    if (!usesAgent) return this.direct(request, options)

    if (request.stream) {
      return {
        kind: "stream",
        body: createAgentStream({
          model: request.model,
          includeUsage: request.includeUsage,
          signal: options.signal,
          run: ({ signal, onProgress }) => this.runAgent(request, signal, onProgress)
        })
      }
    }
    const result = await this.runAgent(request, options.signal)
    return { kind: "json", body: completionFromAgent(result, request.model) }
  }

  private async applyDefaults(request: ParsedChatCompletionRequest): Promise<void> {
    const defaults = await this.settings.getGenerationDefaults()
    if (request.temperature === undefined) request.portalPayload.temperature = defaults.temperature
    if (request.topP === undefined) request.portalPayload.top_p = defaults.topP
    if (request.maxTokens === undefined) request.portalPayload.max_tokens = defaults.maxTokens
  }

  private async direct(request: ParsedChatCompletionRequest, options: HandleChatOptions): Promise<ChatServiceResult> {
    const exchange = await this.pool.openChat(request.portalPayload, { signal: options.signal })
    if (request.stream) {
      if (exchange.kind !== "stream") throw wrongExchange("stream")
      return {
        kind: "stream",
        body: normalizePortalStream(exchange.response.body, request.model, request.includeUsage)
      }
    }
    if (exchange.kind !== "json") throw wrongExchange("json")
    return { kind: "json", body: normalizePortalCompletion(exchange.value, request.model) }
  }

  private async runAgent(
    request: ParsedChatCompletionRequest,
    signal: AbortSignal | undefined,
    onProgress?: (content: string) => void
  ): Promise<AgentProtocolResult> {
    const configuredMaxTokens = request.portalPayload.max_tokens
    const maxTokens = typeof configuredMaxTokens === "number" && Number.isSafeInteger(configuredMaxTokens)
      ? configuredMaxTokens
      : undefined
    return runAgentProtocol({
      messages: cloneJson(request.messages),
      toolPlan: request.toolPlan,
      responseFormat: request.responseFormat,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      callIdPrefix: randomUUID().replaceAll("-", "").slice(0, 16),
      onProgress,
      requestModel: async (messages: ChatMessage[], context) => {
        const payload: JsonObject = {
          ...cloneJson(request.portalPayload),
          messages: cloneJson(messages),
          stream: false
        }
        if (context.maxTokens !== undefined) payload.max_tokens = context.maxTokens
        delete payload.response_format
        const exchange: PortalChatExchange = await this.pool.openChat(payload, { signal })
        if (exchange.kind !== "json") throw wrongExchange("json")
        return portalCompletionToAgentOutput(exchange.value)
      }
    })
  }
}

function wrongExchange(expected: "json" | "stream"): ApiError {
  return new ApiError(`Internal portal exchange did not return ${expected}`, {
    status: 500,
    code: "internal_exchange_mismatch"
  })
}
