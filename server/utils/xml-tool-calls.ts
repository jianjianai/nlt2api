import { XMLValidator } from "fast-xml-parser";
import { parse as parseTolerantXml } from "txml";
import type { JsonObject, JsonValue, ToolDefinition } from "~/server/utils/types.ts";

/**
 * XML wire-format support for the controlled tool-call envelope.
 *
 * Some upstream models produce XML more reliably than JSON (and vice versa),
 * so the adapter contract offers both envelopes and lets the model pick.
 *
 * Parsing is verbatim by design: a <parameter> value is always a raw string,
 * ending at the first </parameter> that is followed by a structural
 * continuation (a sibling <parameter>, a closing </tool_call> or </invoke>,
 * the closing </tool_calls>, another </parameter>, or the end of the input).
 * Embedded markup, angle brackets and ampersands are value text — models
 * never escape entities or wrap values in CDATA (CDATA written under older
 * contracts is still unwrapped). A purpose-built envelope scanner implements
 * these semantics directly; when it finds no call at all, the strict
 * validator and the tolerant txml parser still run, but only to build a
 * located diagnostic for the repair loop.
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
    + "write parameter values as raw text with no escaping and no CDATA sections; "
    + "put every call inside one <tool_calls> root element.",
  );
  lines.push(
    "Return exactly one valid envelope as assistant content, with no prose, markdown, or code fences.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Domain-aware envelope scanner (last-resort fallback)
// ---------------------------------------------------------------------------

const XML_ENTITY_MAP: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITY_MAP[entity] ?? match;
  });
}

interface ScannedTag {
  lt: number;
  close: boolean;
  name: string;
  raw: string;
  end: number;
  selfClosing: boolean;
}

/**
 * Find the next tag-like token, quote-aware so a `>` inside an attribute
 * value does not end the tag early. `<` followed by anything other than a
 * letter or `/` is literal text (covers raw `<` like `a < 400` in values).
 */
function nextXmlTag(text: string, from: number): ScannedTag | undefined {
  let lt = text.indexOf("<", from);
  while (lt >= 0) {
    const marker = text[lt + 1];
    if (marker === "/" || (marker !== undefined && /[A-Za-z]/.test(marker))) {
      let cursor = lt + 1;
      let quote: string | undefined;
      while (cursor < text.length) {
        const ch = text[cursor];
        if (quote) {
          if (ch === quote) quote = undefined;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ">") {
          break;
        }
        cursor += 1;
      }
      if (cursor >= text.length) {
        return undefined; // truncated tag
      }
      const raw = text.slice(lt, cursor + 1);
      const name = /^<\/?\s*([A-Za-z][\w.-]*)/.exec(raw)?.[1];
      if (name) {
        return { lt, close: marker === "/", name, raw, end: cursor + 1, selfClosing: /\/\s*>$/.test(raw) };
      }
    }
    lt = text.indexOf("<", lt + 1);
  }
  return undefined;
}

function readXmlTagAttribute(raw: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(raw);
  if (!match) {
    return undefined;
  }
  return decodeXmlEntities(match[2] ?? match[3] ?? "");
}

/**
 * Last-resort envelope scanner. The envelope grammar is fixed and tiny —
 * a <tool_calls> root, an optional <preamble>, and <tool_call name="...">
 * elements whose <parameter name="..."> children carry raw text — so a
 * purpose-built scanner recovers the malformations generic XML parsers
 * cannot: raw `<` or embedded markup inside parameter values (e.g. Vue/HTML
 * code being edited), stray duplicate close tags, and alias close tags like
 * </invoke>. Parameter content is read as raw text up to the first
 * </parameter>, which is unambiguous because parameters never legitimately
 * contain child elements.
 */
function scanToolCallEnvelope(text: string): { value: unknown; changes: string[] } | undefined {
  const changes = new Set<string>();
  const n = text.length;

  // A parameter value is raw text, parsed verbatim: it ends at the first
  // </parameter> followed by a structural continuation — a sibling
  // <parameter>, a closing </tool_call> or </invoke>, the closing
  // </tool_calls>, another </parameter> (the duplicate-close failure mode),
  // or the end of the input. An embedded </parameter> followed by anything
  // else is value text, so values never need CDATA sections or escaping.
  const ANCESTOR_TERMINATORS = ["</tool_call", "</invoke", "</tool_calls"];
  const PARAMETER_BOUNDARIES = ["<parameter", "</parameter", ...ANCESTOR_TERMINATORS];
  const boundaryAfter = (pos: number): boolean => {
    const ch = text[pos];
    return ch === undefined || ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  };
  const isValueBoundary = (after: number): boolean => {
    let cursor = after;
    while (cursor < n && /\s/.test(text[cursor]!)) cursor += 1;
    if (cursor >= n) {
      return true;
    }
    return PARAMETER_BOUNDARIES.some((boundary) => text.startsWith(boundary, cursor));
  };
  function readParameterValue(from: number): { value: string; end: number } {
    let value = "";
    let cursor = from;
    while (cursor < n) {
      if (text.startsWith("<![CDATA[", cursor)) {
        // CDATA is never required, but sections written under older contracts
        // are still unwrapped (their content is verbatim by definition).
        const cdataEnd = text.indexOf("]]>", cursor + 9);
        if (cdataEnd < 0) {
          value += text.slice(cursor + 9);
          changes.add("recovered a truncated CDATA section");
          return { value, end: n };
        }
        value += text.slice(cursor + 9, cdataEnd);
        cursor = cdataEnd + 3;
        continue;
      }
      if (text.startsWith("</parameter", cursor) && boundaryAfter(cursor + 11)) {
        const gt = text.indexOf(">", cursor);
        const end = gt < 0 ? n : gt + 1;
        if (isValueBoundary(end)) {
          return { value, end };
        }
        // An embedded </parameter> with no structural continuation after it
        // is literal value text.
        value += text.slice(cursor, end);
        cursor = end;
        continue;
      }
      const ancestor = ANCESTOR_TERMINATORS.find((candidate) => text.startsWith(candidate, cursor));
      if (ancestor) {
        changes.add("recovered an unclosed parameter element");
        return { value, end: cursor };
      }
      value += text[cursor]!;
      cursor += 1;
    }
    changes.add("recovered a truncated parameter value");
    return { value, end: n };
  }

  // Read the raw text content of an element up to its matching close tag.
  function readElementText(from: number, name: string): { value: string; end: number } {
    const closer = `</${name}`;
    const closeAt = text.indexOf(closer, from);
    if (closeAt < 0) {
      changes.add(`recovered a truncated <${name}> element`);
      return { value: text.slice(from), end: n };
    }
    return { value: text.slice(from, closeAt), end: closeAt + closer.length };
  }

  // CDATA written under older contracts is still unwrapped; its content is
  // verbatim by definition.
  function unwrapCdataSections(value: string): string {
    return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  }

  // The legacy <arguments><a>1</a><b>2</b></arguments> notation is structural:
  // child elements become argument keys, and a value itself composed of child
  // elements becomes a nested object; anything else stays a raw string.
  function legacyElementValue(raw: string): JsonValue {
    const nested = raw.includes("<") ? parseArgumentElements(raw) : undefined;
    return nested ?? unwrapCdataSections(raw);
  }

  function parseArgumentElements(content: string): JsonObject | undefined {
    const output: Record<string, JsonValue> = {};
    let cursor = 0;
    let found = false;
    while (cursor < content.length) {
      const tag = nextXmlTag(content, cursor);
      if (!tag) {
        break;
      }
      if (tag.close) {
        changes.add(`dropped a stray </${tag.name}> close tag`);
        cursor = tag.end;
        continue;
      }
      const closer = `</${tag.name}`;
      const closeAt = content.indexOf(closer, tag.end);
      const raw = closeAt < 0 ? content.slice(tag.end) : content.slice(tag.end, closeAt);
      output[tag.name] = legacyElementValue(raw);
      found = true;
      cursor = closeAt < 0 ? content.length : closeAt + closer.length;
    }
    return found ? output : undefined;
  }

  function readToolCall(tag: ScannedTag): { call: JsonObject; end: number } | undefined {
    if (tag.name === "invoke") {
      changes.add("rewrote <invoke> as <tool_call>");
    }
    let name = readXmlTagAttribute(tag.raw, "name");
    const parameters: JsonObject[] = [];
    let argumentsValue: JsonValue | undefined;
    const direct: Record<string, JsonValue> = {};
    let cursor = tag.end;
    while (cursor < n) {
      const next = nextXmlTag(text, cursor);
      if (!next) {
        changes.add("recovered a truncated tool_call element");
        cursor = n;
        break;
      }
      if (next.close) {
        if (next.name === "tool_call" || next.name === "invoke") {
          cursor = next.end;
          break;
        }
        if (next.name === "tool_calls") {
          break; // the root closed early; leave it for the outer loop
        }
        // A close tag matching nothing open here is stray markup (the
        // observed duplicate-</parameter> failure mode, among others).
        changes.add(`dropped a stray </${next.name}> close tag`);
        cursor = next.end;
        continue;
      }
      if (next.name === "parameter") {
        const paramName = readXmlTagAttribute(next.raw, "name");
        if (next.selfClosing) {
          if (paramName) parameters.push({ "@_name": paramName, "#text": "" });
          cursor = next.end;
          continue;
        }
        const value = readParameterValue(next.end);
        if (paramName) {
          parameters.push({ "@_name": paramName, "#text": value.value });
        }
        cursor = value.end;
        continue;
      }
      if (next.name === "name") {
        const content = readElementText(next.end, "name");
        name = name ?? content.value.trim();
        cursor = content.end;
        continue;
      }
      if (next.name === "arguments") {
        // <arguments>{"a":1}</arguments> carries JSON text; the element
        // notation <arguments><a>1</a></arguments> carries child elements.
        const content = readElementText(next.end, "arguments");
        const trimmed = content.value.trim();
        argumentsValue = trimmed.startsWith("{") ? trimmed : parseArgumentElements(content.value);
        cursor = content.end;
        continue;
      }
      // Tolerate argument elements placed directly on the call element:
      // <tool_call><name>bash</name><command>ls</command></tool_call>.
      const directValue = readElementText(next.end, next.name);
      direct[next.name] = legacyElementValue(directValue.value);
      cursor = directValue.end;
    }
    if (!name) {
      return undefined;
    }
    const call: JsonObject = { "@_name": name };
    if (parameters.length > 0) {
      call.parameter = parameters;
    }
    if (argumentsValue !== undefined) {
      call.arguments = argumentsValue;
    }
    for (const [key, value] of Object.entries(direct)) {
      call[key] = value;
    }
    return { call, end: cursor };
  }

  // Linear top-level scan: rooted documents, junk wrappers and bare
  // <tool_call> fragments are all handled uniformly — unknown open tags are
  // descended into, stray close tags are skipped, prose between tags is
  // ignored (and reported).
  const calls: JsonObject[] = [];
  let preamble: string | undefined;
  let skippedProse = false;
  let sawRoot = false;
  let sawCallElement = false;
  let cursor = 0;
  while (cursor < n) {
    const tag = nextXmlTag(text, cursor);
    if (!tag) {
      if (text.slice(cursor).trim()) skippedProse = true;
      break;
    }
    if (tag.lt > cursor && text.slice(cursor, tag.lt).trim()) {
      skippedProse = true;
    }
    if (tag.close) {
      // The root's own close tag is expected; anything else is stray markup.
      if (tag.name !== "tool_calls") {
        changes.add(`dropped a stray </${tag.name}> close tag`);
      }
      cursor = tag.end;
      continue;
    }
    if (tag.name === "tool_calls") {
      sawRoot = true;
      cursor = tag.end;
      continue;
    }
    if (tag.name === "preamble") {
      const closeAt = text.indexOf("</preamble", tag.end);
      const rawText = closeAt < 0 ? text.slice(tag.end) : text.slice(tag.end, closeAt);
      const value = rawText.trim();
      if (value) preamble = value;
      if (closeAt < 0) {
        cursor = n;
      } else {
        const gt = text.indexOf(">", closeAt);
        cursor = gt < 0 ? n : gt + 1;
      }
      continue;
    }
    if (tag.name === "tool_call" || tag.name === "invoke") {
      sawCallElement = true;
      const scanned = readToolCall(tag);
      if (scanned) {
        calls.push(scanned.call);
        cursor = scanned.end;
        continue;
      }
      cursor = tag.end;
      continue;
    }
    cursor = tag.end;
  }
  if (calls.length === 0) {
    // An explicitly empty, otherwise clean root still produces an envelope so
    // the shared "at least one call" validation message applies; a root with
    // stray markup or text content falls through to the JSON-in-root
    // tolerance or the located parse diagnostic instead.
    if (sawRoot && changes.size === 0 && !skippedProse) {
      return { value: { tool_calls: { tool_call: [] } }, changes: [] };
    }
    // Call fragments whose content carried no usable name still produce an
    // (empty) envelope, so the repair loop gets the shared "at least one
    // call" message rather than a parse diagnostic.
    if (sawCallElement) {
      if (!sawRoot) {
        changes.add("wrapped bare <tool_call> elements in a <tool_calls> root");
      }
      if (skippedProse) {
        changes.add("ignored prose or markdown fences outside the <tool_calls> document");
      }
      return { value: { tool_calls: { tool_call: [] } }, changes: [...changes] };
    }
    return undefined;
  }
  if (!sawRoot) {
    changes.add("wrapped bare <tool_call> elements in a <tool_calls> root");
  }
  if (skippedProse) {
    changes.add("ignored prose or markdown fences outside the <tool_calls> document");
  }
  const root: JsonObject = { tool_call: calls };
  if (preamble) {
    root.preamble = preamble;
  }
  return { value: { tool_calls: root }, changes: [...changes] };
}

/**
 * Parse the XML envelope with the domain-aware scanner, which implements the
 * canonical verbatim semantics directly: parameter values are raw text, so
 * embedded markup, bare ampersands and angle brackets need no escaping and
 * no CDATA. When the scanner finds no call at all, the strict validator and
 * the tolerant txml parser still run — but only to build a located,
 * AI-friendly diagnostic for the repair loop.
 */
export function parseRepairXml(input: string): XmlParseResult {
  const trimmed = input.trim();
  const scanned = scanToolCallEnvelope(trimmed);
  if (scanned) {
    return { value: scanned.value, repaired: scanned.changes.length > 0, changes: scanned.changes };
  }
  // Mixed-format tolerance: <tool_calls>{"type":"tool_calls",...}</tool_calls>.
  const jsonInRoot = /<tool_calls[^>]*>\s*(\{[\s\S]*\})\s*<\/tool_calls\s*>/.exec(trimmed);
  if (jsonInRoot) {
    try {
      JSON.parse(jsonInRoot[1]!);
      return {
        value: { tool_calls: jsonInRoot[1] },
        repaired: true,
        changes: ["parsed JSON text inside the <tool_calls> root"],
      };
    } catch {
      // Fall through to the diagnostic.
    }
  }
  const validationError = validateXml(trimmed);
  let tolerantError: unknown;
  try {
    parseTolerantXml(trimmed, {
      decodeEntities: true,
      skipXmlDeclaration: true,
      // The envelope has no HTML void elements; without this, an argument
      // named <link> or <input> would silently swallow following content.
      selfClosingTags: [],
    });
  } catch (error) {
    tolerantError = error;
  }
  return { error: friendlyXmlParseError(trimmed, validationError, tolerantError) };
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
  const direct = objectValue(properties?.[key]);
  if (direct) {
    return direct;
  }
  // Map-typed objects declare their value schema via patternProperties or
  // additionalProperties; without this fallback their values hit the untyped
  // branch, which coerces "true"/"false" strings into booleans.
  const patterns = objectValue(schema?.patternProperties);
  if (patterns) {
    for (const [pattern, subschema] of Object.entries(patterns)) {
      try {
        if (new RegExp(pattern).test(key)) {
          const matched = objectValue(subschema);
          if (matched) {
            return matched;
          }
        }
      } catch {
        // An invalid regex in a declared schema is ignored here; Ajv reports it.
      }
    }
  }
  return objectValue(schema?.additionalProperties);
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

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

// Scalar constraints render as attributes; nested structures and enums get
// dedicated elements; any other keyword falls back to a <constraint> element
// carrying JSON text so no semantic rule is silently dropped (Ajv still
// validates the original schema server-side).
const XML_SCHEMA_SCALAR_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "multipleOf",
]);

const XML_SCHEMA_HANDLED_KEYWORDS = new Set([
  ...XML_SCHEMA_SCALAR_KEYWORDS,
  "type",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "pattern",
  "uniqueItems",
  "description",
  "enum",
]);

function schemaNodeToXml(
  element: string,
  name: string | undefined,
  schema: JsonObject | undefined,
  required: boolean,
  indent: string,
  childElement: string,
): string {
  const attributes: string[] = [];
  if (name !== undefined) {
    attributes.push(`name="${escapeXmlAttribute(name)}"`);
  }
  const children: string[] = [];
  if (schema) {
    const type = schemaType(schema);
    if (type) {
      attributes.push(`type="${type}"`);
    }
    if (required) {
      attributes.push('required="true"');
    }
    for (const keyword of XML_SCHEMA_SCALAR_KEYWORDS) {
      const value = schema[keyword];
      if (typeof value === "number" || typeof value === "boolean") {
        attributes.push(`${keyword}="${value}"`);
      }
    }
    if (typeof schema.pattern === "string") {
      attributes.push(`pattern="${escapeXmlAttribute(schema.pattern)}"`);
    }
    if (schema.uniqueItems === true) {
      attributes.push('uniqueItems="true"');
    }
    if (schema.additionalProperties === false) {
      attributes.push('additionalProperties="false"');
    }
    const childIndent = `${indent}  `;
    if (typeof schema.description === "string" && schema.description.trim()) {
      children.push(`${childIndent}<description>${escapeXmlText(schema.description.trim())}</description>`);
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      const values = schema.enum
        .map((value) => `${childIndent}  <value>${escapeXmlText(value === null ? "null" : String(value))}</value>`)
        .join("\n");
      children.push(`${childIndent}<enum>\n${values}\n${childIndent}</enum>`);
    }
    const properties = objectValue(schema.properties);
    if (properties) {
      const requiredKeys = new Set(
        Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [],
      );
      for (const [key, subschema] of Object.entries(properties)) {
        children.push(schemaNodeToXml(childElement, key, objectValue(subschema), requiredKeys.has(key), childIndent, "property"));
      }
    }
    if (type === "array" && objectValue(schema.items)) {
      children.push(schemaNodeToXml("items", undefined, objectValue(schema.items), false, childIndent, "property"));
    }
    const additional = objectValue(schema.additionalProperties);
    if (additional) {
      children.push(schemaNodeToXml("additionalProperties", undefined, additional, false, childIndent, "property"));
    }
    for (const [keyword, value] of Object.entries(schema)) {
      if (XML_SCHEMA_HANDLED_KEYWORDS.has(keyword) || keyword.startsWith("$") || keyword === "title") {
        continue;
      }
      children.push(`${childIndent}<constraint name="${escapeXmlAttribute(keyword)}">${escapeXmlText(JSON.stringify(value))}</constraint>`);
    }
  } else if (required) {
    attributes.push('required="true"');
  }
  const opening = attributes.length > 0 ? `<${element} ${attributes.join(" ")}>` : `<${element}>`;
  if (children.length === 0) {
    return `${indent}${opening.replace(/>$/, "/>")}`;
  }
  return `${indent}${opening}\n${children.join("\n")}\n${indent}</${element}>`;
}

/**
 * Render the declared tool definitions as an XML document for pinned XML
 * mode: models imitate the notation they see, and a JSON schema block would
 * nudge them back toward the JSON envelope.
 */
export function toolDefinitionsToXml(tools: ToolDefinition[]): string {
  const rendered = tools.map((tool) => {
    const lines: string[] = [];
    if (typeof tool.function.description === "string" && tool.function.description.trim()) {
      lines.push(`  <description>${escapeXmlText(tool.function.description.trim())}</description>`);
    }
    const parameters = objectValue(tool.function.parameters) ?? { type: "object" };
    lines.push(schemaNodeToXml("parameters", undefined, parameters, false, "  ", "parameter"));
    return `<function name="${escapeXmlAttribute(tool.function.name)}">\n${lines.join("\n")}\n</function>`;
  });
  return `<functions>\n${rendered.join("\n")}\n</functions>`;
}

/** XML counterpart of the JSON repair-escalation skeleton. */
export function buildXmlSkeleton(calls: { name: string; arguments: JsonObject }[]): string {
  const body = calls.map((call) => {
    const args = Object.entries(call.arguments)
      .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
      .map(([key, value]) => {
        // Parameter values are raw text written verbatim; nested structures
        // travel as JSON text.
        const text = value !== null && typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
        return `    <parameter name="${escapeXmlAttribute(key)}">${text}</parameter>`;
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
