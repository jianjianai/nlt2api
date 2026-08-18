import type { ChatMessage, JsonObject, JsonValue, NormalizedToolCall, ToolDefinition } from "~/server/utils/types.ts";

const TOOL_CONTRACT = [
  "Return exactly one JSON object and no markdown or prose outside it.",
  "For calls use {\"type\":\"tool_calls\",\"tool_calls\":[{\"name\":\"declared_function_name\",\"arguments\":{}}]}.",
  "For a user-facing answer use {\"type\":\"final\",\"content\":\"answer\"}.",
  "Only use declared function names. Arguments must be JSON objects.",
].join(" ");

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toArguments(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return objectValue(parsed) ? JSON.stringify(parsed) : undefined;
    } catch {
      return undefined;
    }
  }
  if (objectValue(value)) {
    return JSON.stringify(value);
  }
  return undefined;
}

function stableCallId(seed: string, index: number): string {
  return `call_${seed.replace(/[^a-zA-Z0-9]/g, "").slice(-16) || "response"}_${index + 1}`;
}

function safeCallId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function deduplicateCallIds(calls: NormalizedToolCall[], seed: string): NormalizedToolCall[] {
  const used = new Set<string>();
  return calls.map((call, index) => {
    let id = call.id;
    if (used.has(id)) {
      let suffix = index;
      id = stableCallId(seed, suffix);
      while (used.has(id)) {
        suffix += 1;
        id = stableCallId(seed, suffix);
      }
    }
    used.add(id);
    return id === call.id ? call : { ...call, id };
  });
}

function normalizeCandidate(
  candidate: unknown,
  declaredTools: Set<string>,
  seed: string,
  index: number,
): NormalizedToolCall | undefined {
  const object = objectValue(candidate);
  if (!object) {
    return undefined;
  }

  const nestedFunction = objectValue(object.function);
  const legacyFunction = objectValue(object.function_call);
  const source = nestedFunction ?? legacyFunction ?? object;
  const name = stringValue(source.name);
  const argumentsValue = toArguments(source.arguments);
  if (!name || !argumentsValue || !declaredTools.has(name)) {
    return undefined;
  }

  const requestedId = safeCallId(object.id) ?? safeCallId(object.call_id) ?? safeCallId(object.tool_call_id);
  return {
    id: requestedId || stableCallId(seed, index),
    type: "function",
    function: { name, arguments: argumentsValue },
  };
}

export type ControlledToolEnvelope =
  | { type: "tool_calls"; toolCalls: NormalizedToolCall[] }
  | { type: "final"; content: string };

export class InvalidStructuredToolCallsError extends Error {
  constructor() {
    super("The upstream returned one or more invalid structured tool calls.");
    this.name = "InvalidStructuredToolCallsError";
  }
}

export function envelopeAllowedForToolChoice(envelope: ControlledToolEnvelope | undefined, toolChoice: unknown): boolean {
  if (!envelope) {
    return false;
  }
  if (envelope.type === "tool_calls") {
    return true;
  }
  return toolChoice !== "required" && objectValue(toolChoice)?.type !== "function";
}

export function parseControlledToolEnvelope(
  content: string,
  tools: ToolDefinition[] | undefined,
  seed: string,
): ControlledToolEnvelope | undefined {
  const declaredTools = new Set((tools ?? []).map((tool) => tool.function.name));
  try {
    const envelope = objectValue(JSON.parse(content.trim()));
    if (envelope?.type === "final" && typeof envelope.content === "string") {
      return { type: "final", content: envelope.content };
    }
    if (envelope?.type !== "tool_calls" || !Array.isArray(envelope.tool_calls) || declaredTools.size === 0) {
      return undefined;
    }
    const parsedToolCalls = envelope.tool_calls
      .map((candidate, index) => normalizeCandidate(candidate, declaredTools, seed, index))
      .filter((call): call is NormalizedToolCall => Boolean(call));
    if (parsedToolCalls.length !== envelope.tool_calls.length || parsedToolCalls.length === 0) {
      return undefined;
    }
    return { type: "tool_calls", toolCalls: deduplicateCallIds(parsedToolCalls, seed) };
  } catch {
    return undefined;
  }
}

export function extractToolCalls(
  content: string,
  tools: ToolDefinition[] | undefined,
  seed: string,
): { content: string | null; toolCalls: NormalizedToolCall[] } {
  if (!tools?.length || !content.trim()) {
    return { content: content || null, toolCalls: [] };
  }
  const envelope = parseControlledToolEnvelope(content, tools, seed);
  if (envelope?.type === "tool_calls") {
    return { content: null, toolCalls: envelope.toolCalls };
  }
  if (envelope?.type === "final") {
    return { content: envelope.content, toolCalls: [] };
  }
  return { content, toolCalls: [] };
}

export function normaliseAssistantToolCalls(
  message: ChatMessage | undefined,
  tools: ToolDefinition[] | undefined,
  seed: string,
): ChatMessage {
  const original = message ?? { role: "assistant", content: null };
  const declaredTools = new Set((tools ?? []).map((tool) => tool.function.name));
  const structured = Array.isArray(original.tool_calls)
    ? original.tool_calls
      .map((candidate, index) => normalizeCandidate(candidate, declaredTools, seed, index))
      .filter((call): call is NormalizedToolCall => Boolean(call))
    : [];
  if (Array.isArray(original.tool_calls) && original.tool_calls.length > 0 && structured.length !== original.tool_calls.length) {
    throw new InvalidStructuredToolCallsError();
  }

  const content = typeof original.content === "string" ? original.content : "";
  const fallback = structured.length === 0 ? extractToolCalls(content, tools, seed) : { content: content || null, toolCalls: [] };
  const toolCalls = deduplicateCallIds(structured.length > 0 ? structured : fallback.toolCalls, seed);

  return {
    ...original,
    role: "assistant",
    content: structured.length > 0 ? (content || null) : fallback.content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export function withToolCallContract(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  toolChoice: unknown,
  parallelToolCalls = true,
): ChatMessage[] {
  if (!tools?.length || toolChoice === "none") {
    return messages;
  }

  const forcedName = objectValue(toolChoice)?.type === "function"
    ? stringValue(objectValue(objectValue(toolChoice)?.function)?.name)
    : undefined;
  const contract = [
    TOOL_CONTRACT,
    `Declared functions and JSON Schemas: ${JSON.stringify(tools.map((tool) => tool.function))}.`,
    ...(toolChoice === "required" ? ["At least one tool call is required; do not return a final answer on this turn."] : []),
    ...(forcedName ? [`You must call only the function named '${forcedName}'.`] : []),
    ...(!parallelToolCalls ? ["Return at most one tool call."] : []),
  ].join(" ");
  const existing = messages.some((message) => message.role === "system" && message.content === contract);
  if (existing) {
    return messages;
  }

  return [{ role: "system", content: contract }, ...messages];
}

export function stringifyContent(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const object = objectValue(part);
        if (!object) {
          return "";
        }
        return stringValue(object.text) ?? stringValue(object.content) ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return value === null || value === undefined ? "" : JSON.stringify(value);
}
