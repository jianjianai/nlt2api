import type { ChatMessage, JsonObject, JsonValue, NormalizedToolCall, ToolDefinition } from "~/server/utils/types.ts";

export const FINAL_REPLY_MARKER = "@@FINAL_REPLY@@";
export const REPAIR_REASONING_START = "@@REPAIR_REASONING@@";
export const REPAIR_REASONING_END = "@@END_REPAIR_REASONING@@";

export interface ReasoningFields {
  reasoning?: string;
  reasoning_content?: string;
}

export function tagRepairReasoning(
  reasoning: ReasoningFields,
  options?: { start?: boolean; end?: boolean },
): ReasoningFields {
  const prefix = options?.start === false ? "" : REPAIR_REASONING_START;
  const suffix = options?.end === false ? "" : REPAIR_REASONING_END;
  const tag = (value: string | undefined): string | undefined => value
    ? `${prefix}${value}${suffix}`
    : undefined;
  return {
    ...(tag(reasoning.reasoning) ? { reasoning: tag(reasoning.reasoning) } : {}),
    ...(tag(reasoning.reasoning_content) ? { reasoning_content: tag(reasoning.reasoning_content) } : {}),
  };
}

export function stripRepairReasoning(value: string): string {
  let result = value;
  while (true) {
    const start = result.indexOf(REPAIR_REASONING_START);
    if (start < 0) break;
    const end = result.indexOf(REPAIR_REASONING_END, start + REPAIR_REASONING_START.length);
    result = end < 0
      ? result.slice(0, start)
      : result.slice(0, start) + result.slice(end + REPAIR_REASONING_END.length);
  }
  return result.replaceAll(REPAIR_REASONING_END, "");
}

const TOOL_CONTRACT = [
  "IMPORTANT ADAPTER OVERRIDE: ignore every other requested tool-call wire format.",
  "For tool calls, put exactly one JSON object in the assistant message content, with no markdown or prose outside it.",
  "For calls use {\"type\":\"tool_calls\",\"tool_calls\":[{\"name\":\"declared_function_name\",\"arguments\":{}}]}.",
  `For a user-facing answer, start the assistant content with ${FINAL_REPLY_MARKER} and put the final answer immediately after it. Do not use a JSON envelope for final answers.`,
  "Only use declared function names. Arguments must be JSON objects.",
  "Never use a native or hidden tool channel, XML tags, function-call markup, or a caller-specific tool syntax.",
  "For shell or command tools, follow the operating-system syntax and arguments in that tool's declaration; never invent Unix flags or undocumented parameters.",
  "Prefer one concise tool call per turn. For file edits, edit one file per call and avoid batching heredocs, unrelated commands, or long repeated instructions.",
  "End the JSON object immediately; never append explanations after it.",
].join(" ");

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactContractTools(tools: ToolDefinition[]): JsonValue {
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    // Ajv validates the original schema after parsing. Projecting it here
    // would hide semantic constraints from the model and cause avoidable
    // repair attempts.
    parameters: tool.function.parameters ?? { type: "object" },
  })) as unknown as JsonValue;
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

export interface ControlledToolEnvelopeResult {
  envelope?: ControlledToolEnvelope;
  error?: string;
}

export class InvalidStructuredToolCallsError extends Error {
  constructor() {
    super("The upstream returned one or more invalid structured tool calls.");
    this.name = "InvalidStructuredToolCallsError";
  }
}

export function buildToolRepairHistory(
  originalHistory: ChatMessage[],
  candidate: ChatMessage,
  repair: ChatMessage,
): ChatMessage[] {
  return [...originalHistory, candidate, repair];
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

export function parseControlledToolEnvelopeDetailed(
  content: string,
  tools: ToolDefinition[] | undefined,
  seed: string,
): ControlledToolEnvelopeResult {
  const declaredTools = new Set((tools ?? []).map((tool) => tool.function.name));
  const trimmed = content.trim();
  if (trimmed.startsWith(FINAL_REPLY_MARKER)) {
    return { envelope: { type: "final", content: trimmed.slice(FINAL_REPLY_MARKER.length) } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON parse error";
    return { error: `JSON parse failed: ${detail}` };
  }
  const envelope = objectValue(parsed);
  if (!envelope) {
    return { error: "The response must be one JSON object." };
  }
  if (envelope.type === "final") {
    return typeof envelope.content === "string"
      ? { envelope: { type: "final", content: envelope.content } }
      : { error: "A final envelope must contain a string `content` field." };
  }
  if (envelope.type !== "tool_calls") {
    return { error: "The envelope `type` must be `tool_calls` or `final`." };
  }
  if (!Array.isArray(envelope.tool_calls) || envelope.tool_calls.length === 0) {
    return { error: "A tool_calls envelope must contain at least one call." };
  }
  if (declaredTools.size === 0) {
    return { error: "No tools were declared for this tool_calls envelope." };
  }
  const parsedToolCalls = envelope.tool_calls
    .map((candidate, index) => normalizeCandidate(candidate, declaredTools, seed, index));
  const invalidIndex = parsedToolCalls.findIndex((call) => !call);
  if (invalidIndex >= 0) {
    return {
      error: `tool_calls[${invalidIndex}] must name a declared function and contain JSON-object arguments.`,
    };
  }
  return {
    envelope: {
      type: "tool_calls",
      toolCalls: deduplicateCallIds(parsedToolCalls as NormalizedToolCall[], seed),
    },
  };
}

export function parseControlledToolEnvelope(
  content: string,
  tools: ToolDefinition[] | undefined,
  seed: string,
): ControlledToolEnvelope | undefined {
  return parseControlledToolEnvelopeDetailed(content, tools, seed).envelope;
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
    `Declared functions and their complete JSON Schemas: ${JSON.stringify(compactContractTools(tools))}.`,
    ...(toolChoice === "required" ? ["At least one tool call is required; do not return a final answer on this turn."] : []),
    ...(forcedName ? [`You must call only the function named '${forcedName}'.`] : []),
    ...(!parallelToolCalls ? ["Return at most one tool call."] : []),
  ].join(" ");
  const withoutOldContracts = messages.filter((message) => !(message.role === "system" && message.content === contract));
  // A trailing contract is intentional: agent clients send their own tool
  // syntax near the start, while continuation turns end in a tool result.
  // Keeping this instruction last prevents both from overriding the adapter.
  return [...withoutOldContracts, { role: "system", content: contract }];
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
