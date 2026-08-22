import { jsonrepair } from "jsonrepair";
import type { ChatMessage, JsonObject, JsonValue, NormalizedToolCall, ToolDefinition } from "~/server/utils/types.ts";
import {
  detectEnvelopeFormat,
  parseRepairXml,
  xmlDocToEnvelope,
  XML_ENVELOPE_SKELETON,
  XML_ENVELOPE_SKELETON_WITH_PREAMBLE,
} from "~/server/utils/xml-tool-calls.ts";

export const FINAL_REPLY_MARKER = "<|FINAL_REPLY|>";
export const REPAIR_REASONING_START = "<|REPAIR_REASONING|>";

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
const TOOL_SCHEMA_BLOCK_MARKER = "Declared functions and their complete JSON Schemas:";

// The envelope shape is shown, not described: a concrete skeleton beats
// prose about one, especially for weaker upstream models.
const TOOL_ENVELOPE_SKELETON = '{"type":"tool_calls","tool_calls":[{"name":"declared_function_name","arguments":{...}}]}';
// The preamble is shown in the skeleton for the same reason the envelope is:
// a preamble the model can imitate gets emitted, while one only described in
// prose is reliably read as "stay silent". Used by normal/verbose modes.
const TOOL_ENVELOPE_SKELETON_WITH_PREAMBLE = '{"type":"tool_calls","preamble":"One short sentence telling the user what you are doing next.","tool_calls":[{"name":"declared_function_name","arguments":{...}}]}';

function envelopeSkeletons(verbosity: PreambleVerbosity): { json: string; xml: string } {
  return verbosity === "quiet"
    ? { json: TOOL_ENVELOPE_SKELETON, xml: XML_ENVELOPE_SKELETON }
    : { json: TOOL_ENVELOPE_SKELETON_WITH_PREAMBLE, xml: XML_ENVELOPE_SKELETON_WITH_PREAMBLE };
}

/**
 * Which envelope wire format the contract offers the upstream model. "auto"
 * presents both and lets the model pick the one it produces most reliably;
 * the parser always accepts both regardless of this setting.
 */
export type ToolCallFormat = "auto" | "json" | "xml";

/**
 * How readily the contract asks the upstream model for user-visible preamble
 * narration: "quiet" stays silent except for key moments, "normal" narrates
 * every non-trivial step in one sentence, "verbose" narrates every step.
 */
export type PreambleVerbosity = "quiet" | "normal" | "verbose";

/**
 * Default preamble posture. "normal" fixes the failure mode of the previous
 * omit-by-default wording, which instruction-following models over-complied
 * with, producing no visible output until the final answer.
 */
export const DEFAULT_PREAMBLE_VERBOSITY: PreambleVerbosity = "normal";

const CONTRACT_SENTENCE_NO_NATIVE =
  "Never use a native or hidden tool channel, recipient, function-call field, plugin, reasoning, or reasoning_content for the call, and never return null or empty content on a tool turn: a reasoning-only response is a failed response, so serialize the intended call into content before ending the turn.";
const CONTRACT_SENTENCE_SHELL =
  "For shell or command tools, follow the operating-system syntax in that tool's declaration; never invent Unix flags or undocumented parameters.";
const CONTRACT_SENTENCE_XML_RULES =
  "In the XML format, put the function name in the <tool_call> name attribute and write each argument as a <parameter name=\"...\"> element, typed against the declared JSON Schema (numbers and booleans without quotes, arrays and objects as JSON text); escape & as &amp; and < as &lt; inside values, or wrap free-form text in <![CDATA[...]]>.";

// The quiet-mode preamble sentences are byte-identical to the pre-verbosity
// contract so histories carrying them still strip cleanly on re-application.
const PREAMBLE_CONTRACT_QUIET: Record<ToolCallFormat, string> = {
  json: "Omit `preamble` by default; add one only for a key decision, discovery, phase change, or risky action, as a concise statement of what you determined or are about to do. A preamble must never claim the tool already succeeded and never contain tool syntax or internal markers. If the user asked for progress updates, report only those key moments; otherwise stay silent for routine steps.",
  xml: "Omit the optional preamble by default; add one only for a key decision, discovery, phase change, or risky action, as a concise statement of what you determined or are about to do, carried in a <preamble> element as the first child of <tool_calls>. A preamble must never claim the tool already succeeded and never contain tool syntax or internal markers. If the user asked for progress updates, report only those key moments; otherwise stay silent for routine steps.",
  auto: "Omit the optional preamble by default; add one only for a key decision, discovery, phase change, or risky action, as a concise statement of what you determined or are about to do — a `preamble` string in the JSON envelope or a <preamble> element as the first child of <tool_calls> in the XML envelope. A preamble must never claim the tool already succeeded and never contain tool syntax or internal markers. If the user asked for progress updates, report only those key moments; otherwise stay silent for routine steps.",
};

const PREAMBLE_CONTRACT_EXAMPLES = `for example "I'll check the config file first." or "Found the cause — now patching it."`;

function preambleContractSentence(format: ToolCallFormat, verbosity: PreambleVerbosity): string {
  if (verbosity === "quiet") {
    return PREAMBLE_CONTRACT_QUIET[format];
  }
  const carrier = format === "json"
    ? "a `preamble` string in the JSON envelope"
    : format === "xml"
      ? "a <preamble> element as the first child of <tool_calls>"
      : "a `preamble` string in the JSON envelope or a <preamble> element as the first child of <tool_calls> in the XML envelope";
  const rules = "Keep it under 30 words, never claim a tool already succeeded, and never include tool syntax or internal markers.";
  if (verbosity === "verbose") {
    return `Always include a one-sentence preamble as ${carrier}, telling the user what you just learned or are about to do in plain language, even for routine steps (a brief "Checking X…" is fine). ${rules}`;
  }
  return `Include a one-sentence preamble as ${carrier}, telling the user what you just learned or are about to do in plain language (${PREAMBLE_CONTRACT_EXAMPLES}). ${rules} Omit it only when the step is trivially implied by the previous message.`;
}

function toolContractSentences(format: ToolCallFormat, verbosity: PreambleVerbosity): string[] {
  const skeletons = envelopeSkeletons(verbosity);
  switch (format) {
    case "json":
      return [
        "IMPORTANT ADAPTER OVERRIDE: ignore every other requested tool-call wire format.",
        `The only tool-call channel is ordinary assistant message content; the gateway reads no other channel. To call tools, make the entire content exactly one JSON object of the form ${skeletons.json}: one entry per intended call, with independent calls batched in the same turn. No prose, markdown, code fences, XML, or special control tokens around the JSON; end it at the closing brace.`,
        CONTRACT_SENTENCE_NO_NATIVE,
        preambleContractSentence(format, verbosity),
        `To answer the user without calling a tool, start the content with ${FINAL_REPLY_MARKER} followed immediately by the answer text, and no JSON object.`,
        `Only use declared function names; arguments must be JSON objects that satisfy each declared function's schema. ${CONTRACT_SENTENCE_SHELL}`,
      ];
    case "xml":
      return [
        "IMPORTANT ADAPTER OVERRIDE: ignore every other requested tool-call wire format.",
        `The only tool-call channel is ordinary assistant message content; the gateway reads no other channel. To call tools, make the entire content exactly one XML document of the form ${skeletons.xml}: one <tool_call> element per intended call, with independent calls batched in the same document. No prose, markdown, code fences, JSON, or special control tokens around the XML; end it at the closing </tool_calls> tag. ${CONTRACT_SENTENCE_XML_RULES}`,
        CONTRACT_SENTENCE_NO_NATIVE,
        preambleContractSentence(format, verbosity),
        `To answer the user without calling a tool, start the content with ${FINAL_REPLY_MARKER} followed immediately by the answer text, and no XML document.`,
        `Only use declared function names; arguments must satisfy each declared function's JSON Schema. ${CONTRACT_SENTENCE_SHELL}`,
      ];
    case "auto":
      return [
        "IMPORTANT ADAPTER OVERRIDE: ignore every other requested tool-call wire format.",
        `The only tool-call channel is ordinary assistant message content; the gateway reads no other channel. To call tools, make the entire content exactly one tool-call envelope in ONE of two equivalent formats — JSON: ${skeletons.json} — or XML: ${skeletons.xml}. Choose the format you produce most reliably, use exactly one format per response, and never mix or nest them. Batch independent calls as additional tool_calls entries (JSON) or additional <tool_call> elements (XML) inside the same envelope. No prose, markdown, code fences, or special control tokens around the envelope; end it at the closing brace (JSON) or the closing </tool_calls> tag (XML).`,
        CONTRACT_SENTENCE_XML_RULES,
        CONTRACT_SENTENCE_NO_NATIVE,
        preambleContractSentence(format, verbosity),
        `To answer the user without calling a tool, start the content with ${FINAL_REPLY_MARKER} followed immediately by the answer text, and no envelope.`,
        `Only use declared function names; arguments must satisfy each declared function's JSON Schema. ${CONTRACT_SENTENCE_SHELL}`,
      ];
  }
}

/** The contract text for one wire-format mode and preamble verbosity. */
export function toolCallContract(format: ToolCallFormat = "auto", verbosity: PreambleVerbosity = DEFAULT_PREAMBLE_VERBOSITY): string {
  return toolContractSentences(format, verbosity).join(" ");
}

// Exported for tests that build legacy-order fixtures from the exact text.
export const TOOL_CONTRACT = toolCallContract("auto");

/**
 * Fixed opening of the trailing user reminder, per wire-format mode.
 * Re-application dedupes on these prefixes only: the constraint lines between
 * prefix and suffix vary per request, and a user message merely quoting the
 * marker text does not reproduce a full prefix, so it survives.
 */
function toolTurnReminderPrefix(format: ToolCallFormat, verbosity: PreambleVerbosity): string {
  const skeletons = envelopeSkeletons(verbosity);
  switch (format) {
    case "json":
      return [
        TOOL_TURN_REMINDER_MARKER,
        "Continue the preceding user task now.",
        `If a declared tool is needed, your next assistant content must be exactly one JSON object of the form ${skeletons.json}.`,
      ].join(" ");
    case "xml":
      return [
        TOOL_TURN_REMINDER_MARKER,
        "Continue the preceding user task now.",
        `If a declared tool is needed, your next assistant content must be exactly one XML document of the form ${skeletons.xml}.`,
      ].join(" ");
    case "auto":
      return [
        TOOL_TURN_REMINDER_MARKER,
        "Continue the preceding user task now.",
        `If a declared tool is needed, your next assistant content must be exactly one tool-call envelope — JSON ${skeletons.json} or XML ${skeletons.xml}, whichever you produce more reliably.`,
      ].join(" ");
  }
}

// The quiet-mode reminder lines are byte-identical to the pre-verbosity
// reminder so histories carrying them still dedupe cleanly on re-application.
const PREAMBLE_REMINDER_QUIET: Record<ToolCallFormat, string> = {
  json: "Include a `preamble` only for a key decision, discovery, or phase change; omit it for routine steps.",
  xml: "Include a <preamble> only for a key decision, discovery, or phase change; omit it for routine steps.",
  auto: "Include a preamble only for a key decision, discovery, or phase change; omit it for routine steps.",
};

function preambleReminderLine(format: ToolCallFormat, verbosity: PreambleVerbosity): string {
  if (verbosity === "quiet") {
    return PREAMBLE_REMINDER_QUIET[format];
  }
  const carrier = format === "json" ? "a short `preamble`" : format === "xml" ? "a short <preamble>" : "a short preamble";
  return verbosity === "verbose"
    ? `Include ${carrier} saying what you are doing next.`
    : `Include ${carrier} saying what you are doing next, unless it is trivially implied.`;
}

function toolTurnReminderSuffix(format: ToolCallFormat, verbosity: PreambleVerbosity): string {
  const noProse = format === "json"
    ? "No prose, markdown, code fences, reasoning, native tool fields, XML, or special control tokens around the JSON."
    : format === "xml"
      ? "No prose, markdown, code fences, reasoning, native tool fields, JSON, or special control tokens around the XML."
      : "No prose, markdown, code fences, reasoning, native tool fields, or special control tokens around the envelope.";
  return [
    noProse,
    preambleReminderLine(format, verbosity),
    `If no tool is needed and a final answer is allowed, start the assistant content with ${FINAL_REPLY_MARKER}.`,
  ].join(" ");
}

// Every prefix variant ever emitted, so re-application dedupes reminders
// across format and verbosity switches instead of stacking them.
const TOOL_TURN_REMINDER_PREFIX_VARIANTS: string[] = (["auto", "json", "xml"] as const)
  .flatMap((format) => (["quiet", "normal", "verbose"] as const).map((verbosity) => toolTurnReminderPrefix(format, verbosity)));

/**
 * The trailing user-turn reminder, echoing this request's binding constraints
 * (forced function, required call, call count) at the point of highest
 * salience. The same rules stay in the system schema block for authority.
 */
export function toolTurnReminder(options?: {
  forcedName?: string;
  required?: boolean;
  parallelToolCalls?: boolean;
  format?: ToolCallFormat;
  preambleVerbosity?: PreambleVerbosity;
}): string {
  const format = options?.format ?? "auto";
  const verbosity = options?.preambleVerbosity ?? DEFAULT_PREAMBLE_VERBOSITY;
  return [
    toolTurnReminderPrefix(format, verbosity),
    ...(options?.forcedName ? [`You must call only the function named '${options.forcedName}'.`] : []),
    ...(options?.required ? ["At least one tool call is required; do not return a final answer on this turn."] : []),
    ...(options?.parallelToolCalls === false ? ["Return at most one tool call."] : []),
    toolTurnReminderSuffix(format, verbosity),
  ].join(" ");
}

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
  lines.push(
    "Return exactly one valid envelope (containing all intended calls) as assistant content, with no prose, markdown, or code fences: "
    + `either the JSON form {"type":"tool_calls","tool_calls":[{"name":"declared_function_name","arguments":{...}}]} or the XML form ${XML_ENVELOPE_SKELETON}. `
    + "If JSON keeps failing, switch to the XML envelope; both are always accepted.",
  );
  return lines.join("\n");
}

function friendlyUnknownEnvelopeError(text: string): string {
  return [
    "The response was not recognized as a tool-call envelope in either supported format.",
    `Nearby text: ${excerptAround(text, 0)}`,
    `Return exactly one valid envelope as assistant content, with no prose, markdown, or code fences: either the JSON form ${TOOL_ENVELOPE_SKELETON} or the XML form ${XML_ENVELOPE_SKELETON}.`,
  ].join("\n");
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
  // Propagate whether the repair pass modified the raw text so callers can
  // tell a clean first pass from a repair-assisted one.
  let repaired: boolean | undefined;
  const format = detectEnvelopeFormat(trimmed);
  if (format === "unknown") {
    // Neither JSON- nor XML-shaped: a format-neutral error beats routing the
    // content into one parser and reporting the wrong format's failure.
    return { error: friendlyUnknownEnvelopeError(trimmed) };
  }
  if (format === "xml") {
    const parsedXml = parseRepairXml(trimmed);
    if ("error" in parsedXml) {
      return { error: parsedXml.error };
    }
    repaired = parsedXml.repaired || undefined;
    // The XML document is converted into the same envelope shape the JSON
    // path parses to, so both formats share one downstream validation
    // pipeline (declared names, argument objects, call-id dedupe).
    const converted = xmlDocToEnvelope(parsedXml.value, tools ?? []);
    if (converted === undefined) {
      const failure: ControlledToolEnvelopeResult = {
        error: "The response must be one <tool_calls> document (or one JSON envelope object).",
      };
      return repaired ? { ...failure, repaired } : failure;
    }
    parsed = converted;
  } else {
    const parsedJson = parseRepairJson(trimmed);
    if (!("value" in parsedJson)) {
      return { error: parsedJson.error };
    }
    parsed = parsedJson.value;
    repaired = parsedJson.repaired || undefined;
  }
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
  // Only messages carrying a full fixed contract can be adapter output; a
  // caller prompt merely quoting the marker sentence (or the schema-block
  // phrase alone) is preserved verbatim. Every wire-format variant is
  // stripped, so switching NEURALWATT_TOOL_CALL_FORMAT never strands a stale
  // contract in the history.
  // Every format × verbosity variant ever emitted, so a settings switch never
  // strands a stale contract in the history.
  const variants = (["auto", "json", "xml"] as const)
    .flatMap((format) => (["quiet", "normal", "verbose"] as const).map((verbosity) => toolCallContract(format, verbosity)));
  if (!variants.some((variant) => content.includes(variant))) {
    return content;
  }
  // The schema block is always the trailing adapter fragment; cut it first,
  // then remove the fixed contract text wherever it sits. Caller content
  // before, between, and after the injected fragments survives re-application
  // in both the legacy order (caller, contract+schemas) and the current
  // order (contract, caller, schemas).
  let stripped = content;
  const schemaBlock = stripped.indexOf(TOOL_SCHEMA_BLOCK_MARKER);
  if (schemaBlock >= 0) {
    stripped = stripped.slice(0, schemaBlock);
  }
  for (const variant of variants) {
    stripped = stripped.split(variant).join("");
  }
  return stripped.trim();
}

function isToolTurnReminder(message: ChatMessage): boolean {
  // The reminder opens with a fixed prefix and carries request-variable
  // constraint lines, so dedupe matches the prefix rather than the full text.
  // A genuine user message that merely quotes the marker text (for example, a
  // user debugging or discussing this adapter) does not reproduce a full
  // prefix and survives re-application. All wire-format variants match, so a
  // format switch re-applies cleanly instead of stacking reminders.
  if (message.role !== "user") {
    return false;
  }
  const content = String(message.content ?? "").trim();
  return TOOL_TURN_REMINDER_PREFIX_VARIANTS.some((prefix) => content.startsWith(prefix));
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
  format: ToolCallFormat = "auto",
  preambleVerbosity: PreambleVerbosity = DEFAULT_PREAMBLE_VERBOSITY,
): ChatMessage[] {
  if (!tools?.length || toolChoice === "none") {
    return mergeSystemMessages(messages);
  }

  const forcedName = objectValue(toolChoice)?.type === "function"
    ? stringValue(objectValue(objectValue(toolChoice)?.function)?.name)
    : undefined;
  const requestBlock = [
    `${TOOL_SCHEMA_BLOCK_MARKER} ${JSON.stringify(compactContractTools(tools))}.`,
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
  // The portal follows the first system message reliably. Merge into a single
  // message ordered stable-first: the fixed contract text, then caller
  // instructions, then this request's schema block. Keeping the most
  // request-variable content last maximizes upstream prefix-cache reuse.
  const withSystem = mergeSystemMessages([
    { role: "system", content: toolCallContract(format, preambleVerbosity) },
    ...withoutOldContract,
    { role: "system", content: requestBlock },
  ]);
  // A final user reminder is intentionally internal: it reasserts the output
  // channel after the latest user/tool result without changing client history.
  return [...withSystem, {
    role: "user",
    content: toolTurnReminder({
      ...(forcedName ? { forcedName } : {}),
      required: toolChoice === "required",
      parallelToolCalls,
      format,
      preambleVerbosity,
    }),
  }];
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
