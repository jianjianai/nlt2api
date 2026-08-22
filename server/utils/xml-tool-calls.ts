import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parseTolerantXml, type TNode } from "txml";
import type { JsonObject, JsonValue, ToolDefinition } from "~/server/utils/types.ts";

/**
 * XML wire-format support for the controlled tool-call envelope.
 *
 * Some upstream models produce XML more reliably than JSON (and vice versa),
 * so the adapter contract offers both envelopes and lets the model pick.
 * This module mirrors the JSON path's two-pass strategy (JSON.parse then
 * jsonrepair) with two dedicated libraries:
 *
 * 1. Strict pass: fast-xml-parser validates and parses clean documents,
 *    giving precise line/column errors for diagnostics.
 * 2. Repair pass: txml parses tolerantly — it recovers the failure modes
 *    LLMs actually produce (truncation at the token cap, bare ampersands,
 *    markdown fences and surrounding prose, bare <tool_call> fragments)
 *    without any hand-written repair heuristics on our side.
 *
 * When both fail, the model gets an AI-friendly located diagnostic combining
 * the validator's position with txml's error, plus a format escape hatch.
 */

// The skeleton shows the shape models most reliably imitate: the function
// name as a <tool_call> attribute and each argument as a <parameter> element.
// The parser additionally tolerates <name>/<arguments> child elements.
export const XML_ENVELOPE_SKELETON =
  '<tool_calls><tool_call name="declared_function_name"><parameter name="parameter_name">value</parameter></tool_call></tool_calls>';

// Preamble-carrying variant: shown by the contract in normal/verbose modes so
// models imitate the narration instead of staying silent until the final answer.
export const XML_ENVELOPE_SKELETON_WITH_PREAMBLE =
  '<tool_calls><preamble>One short sentence telling the user what you are doing next.</preamble><tool_call name="declared_function_name"><parameter name="parameter_name">value</parameter></tool_call></tool_calls>';

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function excerptAround(text: string, pos: number, radius = 60): string {
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, pos)}>>>${text.slice(pos, pos + 1)}<<<${text.slice(pos + 1, end)}${suffix}`;
}

function findOffset(text: string, line: number, column: number): number {
  let currentLine = 1;
  let currentColumn = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (currentLine === line && currentColumn === column) {
      return index;
    }
    if (text[index] === "\n") {
      currentLine += 1;
      currentColumn = 1;
    } else {
      currentColumn += 1;
    }
  }
  return text.length;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Leaf values stay strings; typing is applied against the declared JSON
  // Schema afterwards, so a string-typed "123" is never silently coerced.
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (tagName) => tagName === "tool_call" || tagName === "invoke" || tagName === "parameter",
});

interface XmlValidationError {
  code: string;
  msg: string;
  line: number;
  col: number;
}

function validateXml(text: string): XmlValidationError | undefined {
  const result = XMLValidator.validate(text);
  if (result === true) {
    return undefined;
  }
  return (result as { err: XmlValidationError }).err;
}

/**
 * Convert a txml element into the same plain-object shape the strict
 * fast-xml-parser pass produces (`@_` attribute keys, repeated children
 * grouped into arrays), so both passes share one envelope pipeline.
 */
function txmlElementToValue(element: TNode): unknown {
  const children = element.children ?? [];
  const elementChildren = children.filter((child): child is TNode => typeof child !== "string");
  const text = children.filter((child): child is string => typeof child === "string").join("");
  const attributes = Object.entries(element.attributes ?? {});
  if (elementChildren.length === 0 && attributes.length === 0) {
    return text.trim();
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of attributes) {
    output[`@_${key}`] = value ?? "";
  }
  const trimmedText = text.trim();
  if (trimmedText) {
    output["#text"] = trimmedText;
  }
  for (const child of elementChildren) {
    const value = txmlElementToValue(child);
    const existing = output[child.tagName];
    if (existing === undefined) {
      output[child.tagName] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      output[child.tagName] = [existing, value];
    }
  }
  return output;
}

interface LocatedToolCalls {
  value: unknown;
  wrapped: boolean;
  extraTopLevelContent: boolean;
}

/**
 * Locate the envelope in a tolerantly parsed DOM: the <tool_calls> root
 * (top-level, or nested inside a junk wrapper element), or bare <tool_call>
 * fragments that get wrapped in a synthetic root. Prose and markdown fences
 * parse as top-level string nodes and are ignored.
 */
function locateToolCalls(dom: (TNode | string)[]): LocatedToolCalls | undefined {
  const elements = dom.filter((node): node is TNode => typeof node !== "string");
  const extraTopLevelContent = elements.length > 1
    || dom.some((node) => typeof node === "string" && node.trim().length > 0);

  const topLevel = elements.find((element) => element.tagName === "tool_calls");
  if (topLevel) {
    return { value: { tool_calls: txmlElementToValue(topLevel) }, wrapped: false, extraTopLevelContent };
  }
  // Breadth-first search for a document wrapped in an extra element layer.
  const queue = [...elements];
  while (queue.length > 0) {
    const element = queue.shift()!;
    if (element.tagName === "tool_calls") {
      return { value: { tool_calls: txmlElementToValue(element) }, wrapped: false, extraTopLevelContent: true };
    }
    queue.push(...element.children.filter((child): child is TNode => typeof child !== "string"));
  }
  const bareCalls = elements.filter((element) => element.tagName === "tool_call" || element.tagName === "invoke");
  if (bareCalls.length > 0) {
    return {
      value: { tool_calls: { tool_call: bareCalls.map(txmlElementToValue) } },
      wrapped: true,
      extraTopLevelContent,
    };
  }
  return undefined;
}

/**
 * A lone <tool_call> root is valid XML but not an envelope. Normalize it
 * structurally (envelope glue, not text repair) so the strict pass offers
 * the same bare-fragment tolerance as the tolerant pass.
 */
function wrapBareCallDocument(doc: unknown): { value: unknown; wrapped: boolean } {
  const object = objectValue(doc);
  if (!object || object.tool_calls !== undefined) {
    return { value: doc, wrapped: false };
  }
  const bare = object.tool_call ?? object.invoke;
  if (bare === undefined) {
    return { value: doc, wrapped: false };
  }
  const calls = Array.isArray(bare) ? bare : [bare];
  return { value: { tool_calls: { tool_call: calls } }, wrapped: true };
}

export type XmlParseResult =
  | { value: unknown; repaired: boolean; changes: string[] }
  | { error: string };

function friendlyXmlParseError(
  text: string,
  validationError: XmlValidationError | undefined,
  tolerantError: unknown,
  note?: string,
): string {
  const lines = [
    "The tool-call XML could not be parsed, and the tolerant txml parser also failed.",
  ];
  if (note) {
    lines.push(note);
  }
  if (validationError) {
    lines.push(`Strict validation error: ${validationError.msg} [${validationError.code}] at line ${validationError.line}, column ${validationError.col}.`);
    // The validator reports unclosed tags as: Invalid ' [ "a", "b" ] ' found.
    const unclosed = /Invalid '\[([\s\S]*?)\]' found/.exec(validationError.msg);
    if (unclosed) {
      try {
        const names = JSON.parse(`[${unclosed[1]}]`) as unknown;
        if (Array.isArray(names) && names.length > 0 && names.every((name) => typeof name === "string")) {
          lines.push(`The document ended but these tags are still open: ${names.map((name) => `<${name}>`).join(", ")}. Close every opened tag; the document must end with </tool_calls>.`);
        }
      } catch {
        // Keep the raw validator message when the tag list is not parseable.
      }
    }
  }
  let excerpt: string | undefined;
  if (tolerantError instanceof Error && tolerantError.message) {
    const compact = tolerantError.message.split("\n").join(" ").trim();
    if (compact) {
      lines.push(`Tolerant parse error: ${compact}`);
    }
    // txml errors carry "Line: L\nColumn: C" with a zero-based line.
    const position = /Line: (\d+)\s+Column: (\d+)/.exec(tolerantError.message);
    if (position) {
      excerpt = excerptAround(text, findOffset(text, Number(position[1]) + 1, Number(position[2]) + 1));
    }
  }
  if (!excerpt && validationError) {
    excerpt = excerptAround(text, findOffset(text, validationError.line, validationError.col));
  }
  if (excerpt) {
    lines.push(`Nearby text: ${excerpt}`);
  }
  lines.push(
    "Common fixes: close every opened tag (the document must end with </tool_calls>); "
    + "escape & as &amp; and < as &lt; inside argument values, or wrap free-form text in <![CDATA[...]]>; "
    + "put every call inside one <tool_calls> root element.",
  );
  lines.push(
    "Return exactly one valid envelope as assistant content, with no prose, markdown, or code fences: "
    + `either the XML form ${XML_ENVELOPE_SKELETON} or the JSON form {"type":"tool_calls","tool_calls":[{"name":"declared_function_name","arguments":{...}}]}. `
    + "If XML keeps failing, switch to the JSON envelope; both are always accepted.",
  );
  return lines.join("\n");
}

/**
 * Parse the XML envelope with a jsonrepair-style two-pass strategy: strict
 * fast-xml-parser validation first, tolerant txml parsing as the repair
 * attempt, and a located diagnostic combining both when neither works.
 */
export function parseRepairXml(input: string): XmlParseResult {
  const trimmed = input.trim();
  const validationError = validateXml(trimmed);
  if (!validationError) {
    const wrapped = wrapBareCallDocument(xmlParser.parse(trimmed));
    return {
      value: wrapped.value,
      repaired: wrapped.wrapped,
      changes: wrapped.wrapped ? ["wrapped bare <tool_call> elements in a <tool_calls> root"] : [],
    };
  }
  let dom: (TNode | string)[];
  try {
    dom = parseTolerantXml(trimmed, {
      decodeEntities: true,
      skipXmlDeclaration: true,
      // The envelope has no HTML void elements; without this, an argument
      // named <link> or <input> would silently swallow following content.
      selfClosingTags: [],
    });
  } catch (tolerantError) {
    return { error: friendlyXmlParseError(trimmed, validationError, tolerantError) };
  }
  const located = locateToolCalls(dom);
  if (!located) {
    return {
      error: friendlyXmlParseError(
        trimmed,
        validationError,
        undefined,
        "No <tool_calls> root element was found in the response.",
      ),
    };
  }
  const changes = ["strict XML validation failed; recovered with the tolerant txml parser"];
  if (located.extraTopLevelContent) {
    changes.push("ignored prose or markdown fences outside the <tool_calls> document");
  }
  if (located.wrapped) {
    changes.push("wrapped bare <tool_call> elements in a <tool_calls> root");
  }
  return { value: located.value, repaired: true, changes };
}

function schemaType(schema: JsonObject | undefined): string | undefined {
  if (!schema) {
    return undefined;
  }
  const type = schema.type;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    const first = type.find((candidate) => candidate !== "null");
    if (typeof first === "string") {
      return first;
    }
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const resolved = schemaType(objectValue(branch));
        if (resolved) {
          return resolved;
        }
      }
    }
  }
  if (objectValue(schema.properties)) {
    return "object";
  }
  if (objectValue(schema.items)) {
    return "array";
  }
  return undefined;
}

function propertySchema(schema: JsonObject | undefined, key: string): JsonObject | undefined {
  const properties = objectValue(schema?.properties);
  return objectValue(properties?.[key]);
}

function itemsSchema(schema: JsonObject | undefined): JsonObject | undefined {
  return objectValue(schema?.items);
}

function coerceString(text: string, schema: JsonObject | undefined, depth: number): unknown {
  const type = schemaType(schema);
  switch (type) {
    case "integer":
    case "number": {
      const value = Number(text);
      return Number.isFinite(value) ? value : text;
    }
    case "boolean":
      if (/^(true|1)$/i.test(text)) return true;
      if (/^(false|0)$/i.test(text)) return false;
      return text;
    case "null":
      return text === "" || text === "null" ? null : text;
    case "array": {
      const trimmed = text.trim();
      if (trimmed.startsWith("[")) {
        try {
          return coerceXmlValue(JSON.parse(trimmed), schema, depth + 1);
        } catch {
          // Fall through to the line/comma split.
        }
      }
      const itemSchema = itemsSchema(schema);
      const parts = trimmed.includes("\n")
        ? trimmed.split(/\r?\n/)
        : trimmed.split(",");
      const items = parts.map((part) => part.trim()).filter((part) => part.length > 0);
      return items.map((item) => coerceXmlValue(item, itemSchema, depth + 1));
    }
    case "object": {
      const trimmed = text.trim();
      if (trimmed.startsWith("{")) {
        try {
          return coerceXmlValue(JSON.parse(trimmed), schema, depth + 1);
        } catch {
          return text;
        }
      }
      return text;
    }
    case "string":
      return text;
    default: {
      // Untyped schema: only JSON-looking structures are converted, so plain
      // strings (including numeric-looking commands like "007") stay strings.
      const trimmed = text.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return text;
        }
      }
      if (trimmed === "true") return true;
      if (trimmed === "false") return false;
      if (trimmed === "null") return null;
      return text;
    }
  }
}

/**
 * Schema-directed coercion of XML leaf strings into typed JSON values. XML
 * carries no types, so the declared JSON Schema is the source of truth:
 * numbers, booleans, arrays, and objects are converted only where the schema
 * asks for them. Anything unconvertible is left as-is so Ajv reports a
 * precise schema error instead of a silent wrong-type call.
 */
export function coerceXmlValue(value: unknown, schema: JsonObject | undefined, depth = 0): unknown {
  if (depth > 8) {
    return value;
  }
  if (Array.isArray(value)) {
    const itemSchema = itemsSchema(schema);
    return value.map((item) => coerceXmlValue(item, itemSchema, depth + 1));
  }
  const object = objectValue(value);
  if (object) {
    if (schemaType(schema) === "array") {
      // Repeated-element convention: <items><item>a</item><item>b</item></items>
      // parses to { item: [a, b] }; unwrap the single repeated key.
      const entries = Object.entries(object).filter(([key]) => !key.startsWith("@_") && key !== "#text");
      if (entries.length === 1) {
        const inner = entries[0]![1];
        const list = Array.isArray(inner) ? inner : [inner];
        const itemSchema = itemsSchema(schema);
        return list.map((item) => coerceXmlValue(item, itemSchema, depth + 1));
      }
      return object;
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      if (key.startsWith("@_") || key === "#text") {
        continue;
      }
      output[key] = coerceXmlValue(item, propertySchema(schema, key), depth + 1);
    }
    return output;
  }
  if (typeof value === "string") {
    return coerceString(value, schema, depth);
  }
  return value;
}

function parameterChildrenToObject(value: unknown): unknown {
  // Anthropic-style <parameter name="command">ls</parameter> children parse to
  // objects carrying the text under #text and the name under the attr prefix.
  const list = Array.isArray(value) ? value : [value];
  const output: Record<string, unknown> = {};
  for (const entry of list) {
    const object = objectValue(entry);
    if (!object) {
      continue;
    }
    const name = object["@_name"];
    if (typeof name !== "string" || !name) {
      continue;
    }
    // A parameter with element children carries a nested object; a text-only
    // parameter carries its scalar (or JSON-text) value under #text.
    const elementKeys = Object.keys(object).filter((key) => !key.startsWith("@_") && key !== "#text");
    output[name] = elementKeys.length > 0
      ? Object.fromEntries(elementKeys.map((key) => [key, object[key]]))
      : object["#text"] ?? "";
  }
  return output;
}

const CALL_CONTAINER_KEYS = new Set(["name", "arguments", "parameter", "#text"]);

function xmlCallToCandidate(call: unknown, tools: ToolDefinition[]): unknown {
  const object = objectValue(call);
  if (!object) {
    return undefined;
  }
  const nameValue = object.name;
  const name = typeof nameValue === "string"
    ? nameValue
    : typeof object["@_name"] === "string"
      ? object["@_name"]
      : undefined;
  if (!name) {
    return undefined;
  }
  const tool = tools.find((candidate) => candidate.function.name === name);
  const schema = tool?.function.parameters;

  let rawArguments: unknown;
  if (object.arguments !== undefined) {
    rawArguments = object.arguments;
  } else if (object.parameter !== undefined) {
    rawArguments = parameterChildrenToObject(object.parameter);
  } else {
    // Tolerate argument elements placed directly on the call element:
    // <tool_call><name>bash</name><command>ls</command></tool_call>.
    const direct: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      if (CALL_CONTAINER_KEYS.has(key) || key.startsWith("@_")) {
        continue;
      }
      direct[key] = item;
    }
    rawArguments = Object.keys(direct).length > 0 ? direct : {};
  }

  // <arguments>{"command":"ls"}</arguments> carries raw JSON text.
  if (typeof rawArguments === "string") {
    const trimmed = rawArguments.trim();
    if (trimmed.startsWith("{")) {
      try {
        rawArguments = JSON.parse(trimmed);
      } catch {
        // Leave the string; the schema validation error will name the field.
      }
    }
  }
  const coerced = coerceXmlValue(rawArguments, schema);
  return {
    name,
    arguments: objectValue(coerced) ?? {},
  };
}

/**
 * Convert a parsed XML document into the same envelope shape the JSON path
 * produces, so both formats share one downstream validation pipeline.
 * Returns undefined when the document is not a <tool_calls> envelope.
 */
export function xmlDocToEnvelope(doc: unknown, tools: ToolDefinition[]): unknown {
  const root = objectValue(doc)?.tool_calls;
  if (root === undefined || root === null) {
    return undefined;
  }
  // <tool_calls>{"type":"tool_calls",...}</tool_calls>: JSON inside the root.
  if (typeof root === "string") {
    try {
      return JSON.parse(root);
    } catch {
      return { type: "tool_calls", tool_calls: [] };
    }
  }
  const rootObject = objectValue(root);
  if (!rootObject) {
    return { type: "tool_calls", tool_calls: [] };
  }
  const preamble = typeof rootObject.preamble === "string" && rootObject.preamble.trim()
    ? rootObject.preamble.trim()
    : undefined;
  const rawCalls = rootObject.tool_call ?? rootObject.invoke;
  const callList = rawCalls === undefined ? [] : Array.isArray(rawCalls) ? rawCalls : [rawCalls];
  const calls = callList
    .map((call) => xmlCallToCandidate(call, tools))
    .filter((call): call is NonNullable<typeof call> => call !== undefined);
  return {
    type: "tool_calls",
    ...(preamble ? { preamble } : {}),
    tool_calls: calls,
  };
}

/**
 * Best-effort declared-name extraction from a failed XML candidate, used to
 * build repair escalation skeletons. Regex-based by design: the candidate is
 * known to be malformed, so a real parser would reject it.
 */
export function extractXmlCallNames(content: string, declared: Set<string>): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(/<name>\s*([^<]+?)\s*<\/name>/g)) {
    if (declared.has(match[1]!)) {
      names.push(match[1]!);
    }
  }
  for (const match of content.matchAll(/<(?:tool_call|invoke)\b[^>]*?\bname="([^"]+)"/g)) {
    if (declared.has(match[1]!)) {
      names.push(match[1]!);
    }
  }
  return [...new Set(names)];
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** XML counterpart of the JSON repair-escalation skeleton. */
export function buildXmlSkeleton(calls: { name: string; arguments: JsonObject }[]): string {
  const body = calls.map((call) => {
    const args = Object.entries(call.arguments)
      .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
      .map(([key, value]) => {
        // Parameter values are scalars or JSON text; nested structures have
        // no element-level notation in the parameter style.
        const text = value !== null && typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
        return `    <parameter name="${escapeXmlText(key)}">${escapeXmlText(text)}</parameter>`;
      })
      .join("\n");
    return [
      `  <tool_call name="${escapeXmlText(call.name)}">`,
      args,
      "  </tool_call>",
    ].filter((line) => line.length > 0).join("\n");
  }).join("\n");
  return `<tool_calls>\n${body}\n</tool_calls>`;
}

// Any tag-like opener marks an XML envelope attempt in a tool-turn context.
// The JSON marker is checked first because JSON argument text can contain
// tag-like strings.
const XML_TAG_PATTERN = /<\/?[a-zA-Z][\w.-]*(?:\s[^>]*)?>/;

/**
 * Format detection shared by the parser and the repair escalations. The
 * leading character decides; when prose precedes the envelope, the envelope
 * roots are sniffed anywhere in the text so the right repair pass runs.
 */
export function detectEnvelopeFormat(content: string): "xml" | "json" | "unknown" {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("<")) {
    return "xml";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (trimmed.includes("<tool_calls") || trimmed.includes("<tool_call") || trimmed.includes("<invoke")) {
    return "xml";
  }
  if (trimmed.includes('"tool_calls"')) {
    return "json";
  }
  if (XML_TAG_PATTERN.test(trimmed)) {
    return "xml";
  }
  return "unknown";
}
