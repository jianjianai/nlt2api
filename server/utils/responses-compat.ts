import type { JsonObject, JsonValue, ToolDefinition } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function publicResponseToolChoice(value: unknown): JsonValue {
  if (value === undefined || value === null) {
    return "auto";
  }
  const choice = asRecord(value);
  const nestedFunction = asRecord(choice?.function);
  const name = typeof choice?.name === "string"
    ? choice.name
    : typeof nestedFunction?.name === "string"
      ? nestedFunction.name
      : undefined;
  if (choice?.type === "function" && name) {
    return { type: "function", name };
  }
  return value as JsonValue;
}

function publicResponseTools(tools: ToolDefinition[]): JsonObject[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
    ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
  }));
}

export function responseCompatibilityFields(request: JsonObject, tools: ToolDefinition[]): JsonObject {
  return {
    parallel_tool_calls: request.parallel_tool_calls !== false,
    tool_choice: publicResponseToolChoice(request.tool_choice),
    tools: publicResponseTools(tools),
  };
}

export function responseEnvelopeFields(
  request: JsonObject,
  tools: ToolDefinition[],
  previousResponseId: string | undefined,
  status: "completed" | "incomplete",
  createdAt: number,
  incompleteReason?: string,
): JsonObject {
  const metadata = asRecord(request.metadata);
  const text = asRecord(request.text);
  const truncation = request.truncation === "auto" || request.truncation === "disabled"
    ? request.truncation
    : "disabled";
  return {
    error: null,
    incomplete_details: status === "incomplete" ? { reason: incompleteReason ?? "max_output_tokens" } : null,
    instructions: request.instructions ?? null,
    metadata: metadata ? metadata as JsonObject : {},
    temperature: typeof request.temperature === "number" ? request.temperature : 1,
    top_p: typeof request.top_p === "number" ? request.top_p : 1,
    background: false,
    completed_at: status === "completed" ? createdAt : null,
    max_output_tokens: typeof request.max_output_tokens === "number" ? request.max_output_tokens : null,
    max_tool_calls: typeof request.max_tool_calls === "number" ? request.max_tool_calls : null,
    previous_response_id: previousResponseId ?? null,
    reasoning: asRecord(request.reasoning) ? request.reasoning as JsonValue : null,
    service_tier: typeof request.service_tier === "string" ? request.service_tier : null,
    store: request.store !== false,
    text: text ? text as JsonObject : { format: { type: "text" } },
    top_logprobs: typeof request.top_logprobs === "number" ? request.top_logprobs : null,
    truncation,
    user: typeof request.user === "string" ? request.user : null,
    ...responseCompatibilityFields(request, tools),
  };
}

export function responseUsage(usage: Record<string, unknown> | undefined): JsonObject {
  const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
  const inputDetails = asRecord(usage?.prompt_tokens_details);
  const outputDetails = asRecord(usage?.completion_tokens_details);
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: typeof outputDetails?.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : 0,
    },
    total_tokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens,
  };
}
