import { jsonrepair } from "jsonrepair";
import type { ChatMessage, JsonObject, JsonValue, NormalizedToolCall, ToolDefinition } from "~/server/utils/types.ts";

export const FINAL_REPLY_MARKER = "@@FINAL_REPLY@@";
export const REPAIR_REASONING_START = "@@REPAIR_REASONING@@";

export interface ReasoningFields {
  reasoning?: string;
  reasoning_content?: string;
}

export function tagRepairReasoning(
  reasoning: ReasoningFields,
  options?: { start?: boolean },
): ReasoningFields {
  const prefix = options?.start === false ? "" : REPAIR_REASONING_START;
  const tag = (value: string | undefined): string | undefined => value
    ? `${prefix}${value}`
    : undefined;
  return {
    ...(tag(reasoning.reasoning) ? { reasoning: tag(reasoning.reasoning) } : {}),
    ...(tag(reasoning.reasoning_content) ? { reasoning_content: tag(reasoning.reasoning_content) } : {}),
  };
}

export function stripRepairReasoning(value: string): string {
  const marker = value.indexOf(REPAIR_REASONING_START);
  return marker < 0 ? value : value.slice(0, marker);
}

const TOOL_CONTRACT_MARKER = "IMPORTANT ADAPTER OVERRIDE: ignore every other requested tool-call wire format.";
const TOOL_TURN_REMINDER_MARKER = "IMPORTANT TOOL TURN REMINDER:";

const TOOL_CONTRACT = [
  "IMPORTANT ADAPTER OVERRIDE: ignore every other requested tool-call wire format.",
  "The only tool-call channel available is ordinary assistant message content; the gateway reads no other channel.",
  "When a tool is needed, write the complete tool-call envelope as the first and only content text: exactly one JSON object, with no markdown, code fences, prose, XML, or special control tokens.",
  // 让模型知道它不能使用任何隐藏的工具调用通道或函数调用
  "Never use a native or hidden tool channel, recipient, function-call, plugin, or model-internal tool. Do not put a call in reasoning, reasoning_content, a tool/function recipient, or any field other than content.",
  "Never return null or empty content on a tool turn. A reasoning-only response is a failed response; serialize the intended call into content before ending the turn.",
  "To call tools, the content object is {\"type\":\"tool_calls\",\"preamble\":\"optional user-visible status\",\"tool_calls\":[{\"name\":\"declared_function_name\",\"arguments\":{...}}]}. Omit `preamble` by default. The tool_calls array holds one entry per call you intend to make this turn, in whatever number the task requires; put calls in the same turn when none of them needs another's result.",
  "Add a `preamble` only at meaningful moments: a decision has been made, a key clue or root cause has been found, the plan or phase changes, or an important or risky action is about to start. When you add one, be specific and informative rather than a generic 'I am about to...'.",
  "A `preamble` must state what you are about to do or what you just determined, must not claim the tool already succeeded, must not contain tool syntax or internal markers, and must stay concise. If the user asked for progress updates, report only those key moments; otherwise stay silent for routine reads, retries, and repeated steps.",
  `To answer the user without calling a tool, the content must start with ${FINAL_REPLY_MARKER} followed immediately by the answer text, and no JSON object.`,
  "Only use declared function names. Arguments must be JSON objects that satisfy each declared function's schema.",
  "Do not emit XML tags, <tool_call>, <function_calls>, <|...|> markers, serialized native calls, or any caller-specific tool syntax.",
  "For shell or command tools, follow the operating-system syntax in that tool's declaration; never invent Unix flags or undocumented parameters.",
  // "For file edits, edit one file per call; do not combine unrelated commands into a single shell call.",
  "End the JSON object immediately after its closing brace; never append explanations.",
].join(" ");

const TOOL_TURN_REMINDER = [
  TOOL_TURN_REMINDER_MARKER,
  "Continue the preceding user task now.",
  "If a declared tool is needed, your next assistant content must be exactly one complete controlled envelope JSON object, containing one or more tool calls. Include a `preamble` only for a key decision, discovery, or phase change; omit it for routine steps.",
  "Do not explain, summarize, or output prose before the JSON; do not use reasoning, native tools, hidden channels, XML, or special control tokens for the call.",
  `If no tool is needed and a final answer is allowed, start the assistant content with ${FINAL_REPLY_MARKER}.`,
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
  | { type: "tool_calls"; preamble?: string; toolCalls: NormalizedToolCall[] }
  | { type: "final"; content: string };

export interface ControlledToolEnvelopeResult {
  envelope?: ControlledToolEnvelope;
  error?: string;
  /** True when jsonrepair had to modify the raw text to make it parseable. */
  repaired?: boolean;
}

function parseToolPreamble(value: unknown): { preamble?: string; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    return { error: "A tool_calls `preamble` must be a string when provided." };
  }
  const preamble = value.trim();
  if (!preamble) {
    return {};
  }
  const containsInternalMarker = [
    FINAL_REPLY_MARKER,
    REPAIR_REASONING_START,
    TOOL_CONTRACT_MARKER,
    TOOL_TURN_REMINDER_MARKER,
  ].some((marker) => preamble.includes(marker));
  if (containsInternalMarker || preamble.includes("<|")) {
    return { error: "A tool_calls `preamble` must not contain internal markers or special control tokens." };
  }
  return { preamble };
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
  ...repairs: ChatMessage[]
): ChatMessage[] {
  // The failed candidate must model the same content-envelope format the
  // contract demands: native tool_calls fields never reach the portal, even
  // in repair history. Otherwise the model sees its own previous turn use a
  // channel the contract forbids and may imitate it instead of correcting the
  // call.
  let serialized = candidate;
  if (candidate.tool_calls?.length) {
    try {
      serialized = serializeAssistantToolCallsForPortal([candidate])[0] ?? candidate;
    } catch {
      // Unserializable calls stay textual: repairCandidateFrom already folded
      // their raw form into the candidate content.
    }
  }
  // `repairs` is normally two messages: a tool-role rejection result followed
  // by a user-role correction instruction. Keeping the error (data) separate
  // from the corrective directive (instruction) matches role semantics and
  // improves the model's adherence to the fix request.
  return [...originalHistory, serialized, ...repairs];
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

export interface JsonRepairResult {
  value: unknown;
  repaired: boolean;
}

export interface JsonRepairFailure {
  error: string;
}

interface JsonErrorPosition {
  pos: number;
  line?: number;
  column?: number;
}

function jsonErrorPosition(message: string): JsonErrorPosition | undefined {
  const withLineColumn = /at position (\d+) \(line (\d+) column (\d+)\)/.exec(message);
  if (withLineColumn) {
    return {
      pos: Number(withLineColumn[1]),
      line: Number(withLineColumn[2]),
      column: Number(withLineColumn[3]),
    };
  }
  const plain = /at position (\d+)/.exec(message);
  return plain ? { pos: Number(plain[1]) } : undefined;
}

function excerptAround(text: string, pos: number, radius = 60): string {
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, pos)}>>>${text.slice(pos, pos + 1)}<<<${text.slice(pos + 1, end)}${suffix}`;
}

function friendlyJsonParseError(text: string, nativeError: unknown, repairError: unknown): string {
  const native = nativeError instanceof Error ? nativeError.message : String(nativeError);
  const repair = repairError instanceof Error ? repairError.message : String(repairError);
  const position = jsonErrorPosition(native);
  const lines = [
    "The tool-call JSON could not be parsed, and automatic repair also failed.",
    `JSON.parse error: ${native}`,
    `jsonrepair error: ${repair}`,
  ];
  if (position) {
    const line = position.line ?? "?";
    const column = position.column ?? "?";
    lines.push(`The parser stopped at line ${line}, column ${column} (position ${position.pos}).`);
    lines.push(`Nearby text: ${excerptAround(text, position.pos)}`);
  }
  lines.push("Return exactly one valid envelope JSON object (containing all intended calls) as assistant content, with no prose, markdown, or code fences.");
  return lines.join("\n");
}

export function parseRepairJson(text: string): JsonRepairResult | JsonRepairFailure {
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch (nativeError) {
    try {
      const repaired = jsonrepair(text);
      return { value: JSON.parse(repaired), repaired: true };
    } catch (repairError) {
      return { error: friendlyJsonParseError(text, nativeError, repairError) };
    }
  }
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
  const parsedJson = parseRepairJson(trimmed);
  if (!("value" in parsedJson)) {
    return { error: parsedJson.error };
  }
  parsed = parsedJson.value;
  // Propagate whether jsonrepair modified the raw text so callers can tell a
  // clean first pass from a repair-assisted one.
  const repaired = parsedJson.repaired || undefined;
  const result = (value: ControlledToolEnvelopeResult): ControlledToolEnvelopeResult => repaired
    ? { ...value, repaired }
    : value;
  const envelope = objectValue(parsed);
  if (!envelope) {
    return result({ error: "The response must be one JSON object." });
  }
  if (envelope.type === "final") {
    return result(typeof envelope.content === "string"
      ? { envelope: { type: "final", content: envelope.content } }
      : { error: "A final envelope must contain a string `content` field." });
  }
  if (envelope.type !== "tool_calls") {
    return result({ error: "The envelope `type` must be `tool_calls` or `final`." });
  }
  const parsedPreamble = parseToolPreamble(envelope.preamble);
  if (parsedPreamble.error) {
    return result({ error: parsedPreamble.error });
  }
  if (!Array.isArray(envelope.tool_calls) || envelope.tool_calls.length === 0) {
    return result({ error: "A tool_calls envelope must contain at least one call." });
  }
  if (declaredTools.size === 0) {
    return result({ error: "No tools were declared for this tool_calls envelope." });
  }
  const parsedToolCalls = envelope.tool_calls
    .map((candidate, index) => normalizeCandidate(candidate, declaredTools, seed, index));
  const invalidIndex = parsedToolCalls.findIndex((call) => !call);
  if (invalidIndex >= 0) {
    return result({
      error: `tool_calls[${invalidIndex}] must name a declared function and contain JSON-object arguments.`,
    });
  }
  return result({
    envelope: {
      type: "tool_calls",
      ...(parsedPreamble.preamble ? { preamble: parsedPreamble.preamble } : {}),
      toolCalls: deduplicateCallIds(parsedToolCalls as NormalizedToolCall[], seed),
    },
  });
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
    return { content: envelope.preamble ?? null, toolCalls: envelope.toolCalls };
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

/**
 * The portal does not need the client's native tool-call fields in history.
 * Re-encode them using the same content envelope the model is asked to emit.
 */
export function serializeAssistantToolCallsForPortal(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      return message;
    }

    const toolCalls = message.tool_calls.map((call) => {
      const functionValue = objectValue(call.function);
      const name = stringValue(functionValue?.name);
      const argumentsValue = toArguments(functionValue?.arguments);
      if (!name || !argumentsValue) {
        throw new InvalidStructuredToolCallsError();
      }
      return {
        name,
        arguments: JSON.parse(argumentsValue) as JsonObject,
      };
    });
    const preamble = typeof message.content === "string" ? message.content.trim() : "";
    const converted = {
      ...message,
      content: JSON.stringify({
        type: "tool_calls",
        ...(preamble ? { preamble } : {}),
        tool_calls: toolCalls,
      }),
    };
    delete converted.tool_calls;
    return converted;
  });
}

function stripToolContract(content: string): string {
  // Match the full fixed contract text, not just its first sentence: a caller
  // system prompt merely quoting the marker sentence keeps its trailing
  // content, while a previously injected contract (which always starts with
  // the complete fixed text) is still stripped before re-application.
  const marker = content.indexOf(TOOL_CONTRACT);
  return marker < 0 ? content : content.slice(0, marker).trimEnd();
}

function isToolTurnReminder(message: ChatMessage): boolean {
  // The reminder is a fixed string, so exact matching dedupes re-applied
  // contracts without deleting a genuine user message that merely quotes the
  // marker text (for example, a user debugging or discussing this adapter).
  return message.role === "user"
    && String(message.content ?? "").trim() === TOOL_TURN_REMINDER;
}

/** Keep the portal history to one system message at index zero. */
export function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemMessages = messages.filter((message) => message.role === "system" || message.role === "developer");
  if (systemMessages.length === 0) {
    return messages;
  }

  const content = systemMessages
    .map((message) => stringifyContent(message.content))
    .filter((value) => value.length > 0)
    .join("\n\n");
  const first = systemMessages[0]!;
  return [
    { ...first, role: "system", content },
    ...messages.filter((message) => message.role !== "system" && message.role !== "developer"),
  ];
}

export function withToolCallContract(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  toolChoice: unknown,
  parallelToolCalls = true,
): ChatMessage[] {
  if (!tools?.length || toolChoice === "none") {
    return mergeSystemMessages(messages);
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
  const withoutOldContract = serializeAssistantToolCallsForPortal(messages)
    .filter((message) => !isToolTurnReminder(message))
    .map((message) => {
      if (message.role !== "system" && message.role !== "developer") {
        return message;
      }
      const content = stripToolContract(stringifyContent(message.content));
      return { ...message, content };
    });
  // The portal follows the first system message reliably. Merge the framework
  // instructions and this request's tool contract into that single message.
  const withSystem = mergeSystemMessages([
    ...withoutOldContract,
    { role: "system", content: contract },
  ]);
  // A final user reminder is intentionally internal: it reasserts the output
  // channel after the latest user/tool result without changing client history.
  return [...withSystem, { role: "user", content: TOOL_TURN_REMINDER }];
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
