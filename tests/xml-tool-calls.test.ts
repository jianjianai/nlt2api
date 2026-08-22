import assert from "node:assert/strict";
import test from "node:test";
import {
  buildXmlSkeleton,
  coerceXmlValue,
  detectEnvelopeFormat,
  extractXmlCallNames,
  parseRepairXml,
  xmlDocToEnvelope,
  XML_ENVELOPE_SKELETON,
} from "../server/utils/xml-tool-calls.ts";
import {
  parseControlledToolEnvelopeDetailed,
  toolCallContract,
  toolTurnReminder,
  TOOL_CONTRACT,
  withToolCallContract,
} from "../server/utils/tool-calls.ts";
import type { ToolDefinition } from "../server/utils/types.ts";

const tools: ToolDefinition[] = [{
  type: "function",
  function: {
    name: "calculator",
    parameters: {
      type: "object",
      properties: {
        a: { type: "integer" },
        b: { type: "integer" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
}];

const shellTools: ToolDefinition[] = [{
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer" },
        flags: { type: "array", items: { type: "string" } },
        options: {
          type: "object",
          properties: {
            verbose: { type: "boolean" },
            retries: { type: "integer" },
          },
        },
      },
      required: ["command"],
    },
  },
}];

test("clean XML envelope produces the same normalized calls as JSON", () => {
  const xml = [
    "<tool_calls>",
    "  <tool_call>",
    "    <name>calculator</name>",
    "    <arguments>",
    "      <a>29</a>",
    "      <b>13</b>",
    "    </arguments>",
    "  </tool_call>",
    "</tool_calls>",
  ].join("\n");
  const result = parseControlledToolEnvelopeDetailed(xml, tools, "chatcmpl-xml");
  assert.equal(result.envelope?.type, "tool_calls");
  assert.equal(result.repaired, undefined);
  if (result.envelope?.type !== "tool_calls") return;
  assert.equal(result.envelope.toolCalls.length, 1);
  assert.equal(result.envelope.toolCalls[0]?.function.name, "calculator");
  // Schema-directed coercion: the declared integer types turn the XML leaf
  // strings into numbers before Ajv ever sees them.
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { a: 29, b: 13 });
  assert.equal(result.envelope.toolCalls[0]?.id, "call_chatcmplxml_1");
});

test("XML envelope accepts the name attribute and JSON arguments text", () => {
  const fromAttribute = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="calculator"><arguments>{"a":1,"b":2}</arguments></tool_call></tool_calls>',
    tools,
    "seed",
  );
  assert.equal(fromAttribute.envelope?.type, "tool_calls");
  if (fromAttribute.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(fromAttribute.envelope.toolCalls[0]!.function.arguments), { a: 1, b: 2 });

  // Argument elements placed directly on the call element are tolerated.
  const direct = parseControlledToolEnvelopeDetailed(
    "<tool_calls><tool_call><name>calculator</name><a>3</a><b>4</b></tool_call></tool_calls>",
    tools,
    "seed",
  );
  assert.equal(direct.envelope?.type, "tool_calls");
  if (direct.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(direct.envelope.toolCalls[0]!.function.arguments), { a: 3, b: 4 });
});

test("the model-preferred attribute+parameter format parses end to end", () => {
  // The format XML-fluent models produce natively, including a bare && that
  // strict validation rejects and the tolerant txml pass recovers.
  const xml = [
    "<tool_calls>",
    '<tool_call name="bash">',
    '<parameter name="command">cd /c/Users/28018/Desktop/neuralwatt-ai && npx tsx --test tests/xml-tool-calls.test.ts 2>&1 | tail -30</parameter>',
    "</tool_call>",
    "</tool_calls>",
  ].join("\n");
  const result = parseControlledToolEnvelopeDetailed(xml, shellTools, "seed");
  assert.equal(result.envelope?.type, "tool_calls");
  assert.equal(result.repaired, true);
  if (result.envelope?.type !== "tool_calls") return;
  assert.equal(result.envelope.toolCalls[0]?.function.name, "bash");
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), {
    command: "cd /c/Users/28018/Desktop/neuralwatt-ai && npx tsx --test tests/xml-tool-calls.test.ts 2>&1 | tail -30",
  });
});

test("parameter elements carry nested objects and JSON text", () => {
  const nested = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="bash"><parameter name="options"><verbose>true</verbose><retries>3</retries></parameter><parameter name="command">ls</parameter></tool_call></tool_calls>',
    shellTools,
    "seed",
  );
  assert.equal(nested.envelope?.type, "tool_calls");
  if (nested.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(nested.envelope.toolCalls[0]!.function.arguments), {
    options: { verbose: true, retries: 3 },
    command: "ls",
  });

  const jsonText = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="bash"><parameter name="options">{"verbose":true,"retries":3}</parameter><parameter name="command">ls</parameter></tool_call></tool_calls>',
    shellTools,
    "seed",
  );
  assert.equal(jsonText.envelope?.type, "tool_calls");
  if (jsonText.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(jsonText.envelope.toolCalls[0]!.function.arguments), {
    options: { verbose: true, retries: 3 },
    command: "ls",
  });
});

test("XML envelope batches parallel calls and carries a preamble", () => {
  const xml = [
    "<tool_calls>",
    "  <preamble>Reading both files now.</preamble>",
    "  <tool_call><name>calculator</name><arguments><a>1</a><b>2</b></arguments></tool_call>",
    "  <tool_call><name>calculator</name><arguments><a>3</a><b>4</b></arguments></tool_call>",
    "</tool_calls>",
  ].join("\n");
  const result = parseControlledToolEnvelopeDetailed(xml, tools, "seed");
  assert.equal(result.envelope?.type, "tool_calls");
  if (result.envelope?.type !== "tool_calls") return;
  assert.equal(result.envelope.preamble, "Reading both files now.");
  assert.equal(result.envelope.toolCalls.length, 2);
  assert.notEqual(result.envelope.toolCalls[0]?.id, result.envelope.toolCalls[1]?.id);
});

test("XML coercion types values against the declared schema only", () => {
  const xml = [
    "<tool_calls><tool_call><name>bash</name><arguments>",
    "<command>echo 007</command>",
    "<timeout>30</timeout>",
    "<flags>[\"-a\", \"-l\"]</flags>",
    "<options><verbose>true</verbose><retries>3</retries></options>",
    "</arguments></tool_call></tool_calls>",
  ].join("");
  const result = parseControlledToolEnvelopeDetailed(xml, shellTools, "seed");
  assert.equal(result.envelope?.type, "tool_calls");
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), {
    command: "echo 007",
    timeout: 30,
    flags: ["-a", "-l"],
    options: { verbose: true, retries: 3 },
  });
});

test("XML coercion unwraps repeated-element arrays and splits scalar lists", () => {
  const schema = { type: "array", items: { type: "integer" } };
  // fast-xml-parser shape for <items><item>1</item><item>2</item></items>.
  assert.deepEqual(coerceXmlValue({ item: ["1", "2"] }, schema as never), [1, 2]);
  assert.deepEqual(coerceXmlValue("1, 2, 3", schema as never), [1, 2, 3]);
  assert.deepEqual(coerceXmlValue("[1, 2]", schema as never), [1, 2]);
  // Untyped schemas leave plain strings alone, including numeric-looking ones.
  assert.equal(coerceXmlValue("007", undefined), "007");
  assert.deepEqual(coerceXmlValue('{"x":1}', undefined), { x: 1 });
  assert.equal(coerceXmlValue("true", undefined), true);
});

test("markdown fences and surrounding prose are repaired away", () => {
  const fenced = [
    "Sure, here are the calls:",
    "```xml",
    "<tool_calls><tool_call><name>calculator</name><arguments><a>1</a><b>2</b></arguments></tool_call></tool_calls>",
    "```",
    "Hope that helps!",
  ].join("\n");
  const result = parseControlledToolEnvelopeDetailed(fenced, tools, "seed");
  assert.equal(result.envelope?.type, "tool_calls");
  assert.equal(result.repaired, true);
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { a: 1, b: 2 });
});

test("truncated XML is auto-closed like truncated JSON", () => {
  const truncated = "<tool_calls><tool_call><name>calculator</name><arguments><a>1</a><b>2";
  const result = parseControlledToolEnvelopeDetailed(truncated, tools, "seed");
  assert.equal(result.envelope?.type, "tool_calls");
  assert.equal(result.repaired, true);
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { a: 1, b: 2 });
});

test("bare ampersands are escaped and CDATA content is preserved", () => {
  const ampersand = parseControlledToolEnvelopeDetailed(
    "<tool_calls><tool_call><name>bash</name><arguments><command>echo a & b</command></arguments></tool_call></tool_calls>",
    shellTools,
    "seed",
  );
  assert.equal(ampersand.envelope?.type, "tool_calls");
  assert.equal(ampersand.repaired, true);
  if (ampersand.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(ampersand.envelope.toolCalls[0]!.function.arguments), { command: "echo a & b" });

  const cdata = parseControlledToolEnvelopeDetailed(
    "<tool_calls><tool_call><name>bash</name><arguments><command><![CDATA[test a < b && c > d]]></command></arguments></tool_call></tool_calls>",
    shellTools,
    "seed",
  );
  assert.equal(cdata.envelope?.type, "tool_calls");
  assert.equal(cdata.repaired, undefined);
  if (cdata.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(cdata.envelope.toolCalls[0]!.function.arguments), { command: "test a < b && c > d" });
});

test("bare tool_call fragments are wrapped in a root element", () => {
  // A lone <tool_call> root is valid XML, so the strict pass parses it and
  // the envelope glue wraps it; multiple bare fragments need the txml pass.
  const single = parseRepairXml("<tool_call><name>calculator</name><arguments><a>1</a><b>2</b></arguments></tool_call>");
  assert.ok("value" in single);
  if (!("value" in single)) return;
  assert.equal(single.repaired, true);
  const envelope = xmlDocToEnvelope(single.value, tools) as { type: string; tool_calls: { name: string }[] };
  assert.equal(envelope.type, "tool_calls");
  assert.equal(envelope.tool_calls[0]?.name, "calculator");

  const multiple = parseRepairXml(
    "<tool_call><name>calculator</name><arguments><a>1</a><b>2</b></arguments></tool_call>"
    + "<tool_call><name>calculator</name><arguments><a>3</a><b>4</b></arguments></tool_call>",
  );
  assert.ok("value" in multiple);
  if (!("value" in multiple)) return;
  const wrapped = xmlDocToEnvelope(multiple.value, tools) as { tool_calls: unknown[] };
  assert.equal(wrapped.tool_calls.length, 2);
});

test("mis-nested tags fail both parsers with a located diagnostic", () => {
  // txml throws on mis-nesting; the repair loop gets a located error.
  const result = parseRepairXml(
    "<tool_calls><tool_call><name>calculator</name><arguments><a>1</a></tool_call></arguments><b>2</b></tool_calls>",
  );
  assert.ok(!("value" in result));
  if ("value" in result) return;
  assert.match(result.error, /could not be parsed/);
  assert.match(result.error, /line \d+, column \d+/);
  assert.match(result.error, />>>/);
});

test("undeclared functions and non-object arguments fail with the shared messages", () => {
  const undeclared = parseControlledToolEnvelopeDetailed(
    "<tool_calls><tool_call><name>missing</name><arguments></arguments></tool_call></tool_calls>",
    tools,
    "seed",
  );
  assert.equal(undeclared.envelope, undefined);
  assert.match(undeclared.error ?? "", /tool_calls\[0\]/);

  const empty = parseControlledToolEnvelopeDetailed("<tool_calls></tool_calls>", tools, "seed");
  assert.equal(empty.envelope, undefined);
  assert.match(empty.error ?? "", /at least one call/);
});

test("unrepairable XML produces a located, AI-friendly diagnostic", () => {
  const result = parseRepairXml("<tool_calls><tool_call><name>bash</name><arguments><command>a < b</command></arguments></tool_call></tool_calls>");
  assert.ok(!("value" in result));
  if ("value" in result) return;
  assert.match(result.error, /could not be parsed/);
  assert.match(result.error, /line \d+, column \d+/);
  assert.match(result.error, />>>/);
  assert.match(result.error, /CDATA/);
  assert.match(result.error, /JSON/);
});

test("unclosed-tag diagnostics name the tags left open", () => {
  // A document the repair pass cannot balance: the root itself never opened.
  const result = parseRepairXml("plain prose with no tags at all");
  assert.ok(!("value" in result));
  if ("value" in result) return;
  assert.match(result.error, /could not be parsed/);
});

test("JSON inside the XML root is accepted as a mixed-format tolerance", () => {
  const result = parseControlledToolEnvelopeDetailed(
    '<tool_calls>{"type":"tool_calls","tool_calls":[{"name":"calculator","arguments":{"a":1,"b":2}}]}</tool_calls>',
    tools,
    "seed",
  );
  assert.equal(result.envelope?.type, "tool_calls");
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { a: 1, b: 2 });
});

test("detectEnvelopeFormat classifies the wire formats", () => {
  assert.equal(detectEnvelopeFormat('  {"type":"tool_calls"}'), "json");
  assert.equal(detectEnvelopeFormat("\n<tool_calls>"), "xml");
  assert.equal(detectEnvelopeFormat("hello"), "unknown");
  // <invoke> and generic tag-like content are XML attempts, never JSON.
  assert.equal(detectEnvelopeFormat('prose then <invoke name="bash">'), "xml");
  assert.equal(detectEnvelopeFormat("text with a <div> tag"), "xml");
});

test("invoke-style XML with leading prose is not misrouted to the JSON path", () => {
  // Regression: a bare <invoke> fragment behind prose must reach the XML
  // parser (which wraps it), not the JSON parser with its misleading error.
  const prose = 'I will run it:\n<invoke name="bash"><parameter name="command">ls</parameter></invoke>';
  const result = parseControlledToolEnvelopeDetailed(prose, shellTools, "seed");
  assert.equal(result.envelope?.type, "tool_calls");
  assert.equal(result.repaired, true);
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { command: "ls" });
});

test("leading whitespace before the XML envelope keeps XML detection", () => {
  const xml = '  \n  <tool_calls>\n  <invoke name="bash">\n  <parameter name="command">ls -la && pwd</parameter>\n  </invoke>\n  </tool_calls>';
  const result = parseControlledToolEnvelopeDetailed(xml, shellTools, "seed");
  assert.equal(result.envelope?.type, "tool_calls");
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { command: "ls -la && pwd" });
});

test("unrecognized content gets a format-neutral error naming both envelopes", () => {
  const result = parseControlledToolEnvelopeDetailed("just plain prose, no envelope at all", tools, "seed");
  assert.equal(result.envelope, undefined);
  assert.match(result.error ?? "", /not recognized as a tool-call envelope/);
  assert.match(result.error ?? "", /JSON/);
  assert.match(result.error ?? "", /XML/);
});

test("extractXmlCallNames lifts declared names from broken candidates", () => {
  const declared = new Set(["calculator", "bash"]);
  const names = extractXmlCallNames(
    '<tool_calls><tool_call><name>calculator</name><arguments><a>1</a><tool_call name="bash"><arguments><command>ls</command>',
    declared,
  );
  assert.deepEqual(names, ["calculator", "bash"]);
  assert.deepEqual(extractXmlCallNames("<name>undeclared</name>", declared), []);
});

test("buildXmlSkeleton renders schema-derived placeholders", () => {
  const skeleton = buildXmlSkeleton([
    { name: "calculator", arguments: { a: 0, b: 0 } },
  ]);
  assert.match(skeleton, /^<tool_calls>/);
  assert.match(skeleton, /<\/tool_calls>$/);
  assert.match(skeleton, /<tool_call name="calculator">/);
  assert.match(skeleton, /<parameter name="a">0<\/parameter>/);
  // The skeleton itself must be a parseable envelope.
  const parsed = parseControlledToolEnvelopeDetailed(skeleton, tools, "seed");
  assert.equal(parsed.envelope?.type, "tool_calls");
});

test("the auto contract offers both formats and lets the model choose", () => {
  assert.match(TOOL_CONTRACT, /IMPORTANT ADAPTER OVERRIDE/);
  assert.match(TOOL_CONTRACT, /\{"type":"tool_calls"/);
  // The default (normal) verbosity shows the preamble inside both skeletons.
  assert.match(TOOL_CONTRACT, /<tool_calls><preamble>/);
  assert.match(TOOL_CONTRACT, /<tool_call name="declared_function_name">/);
  assert.match(TOOL_CONTRACT, /Choose the format you produce most reliably/);
  assert.match(TOOL_CONTRACT, /never mix or nest them/);
  assert.match(TOOL_CONTRACT, /CDATA/);

  const jsonOnly = toolCallContract("json");
  assert.match(jsonOnly, /exactly one JSON object/);
  assert.ok(!jsonOnly.includes(XML_ENVELOPE_SKELETON));

  const xmlOnly = toolCallContract("xml");
  assert.match(xmlOnly, /exactly one XML document/);
  assert.ok(!xmlOnly.includes('{"type":"tool_calls"'));
});

test("the contract and reminder follow the configured preamble verbosity", () => {
  const quiet = toolCallContract("auto", "quiet");
  assert.match(quiet, /Omit the optional preamble by default/);
  assert.ok(!quiet.includes('"preamble":"One short sentence'));
  assert.ok(!quiet.includes("<preamble>One short sentence"));

  const normal = toolCallContract("auto", "normal");
  assert.match(normal, /Include a one-sentence preamble/);
  assert.match(normal, /trivially implied/);
  assert.ok(normal.includes('"preamble":"One short sentence telling the user what you are doing next."'));
  assert.ok(normal.includes("<preamble>One short sentence telling the user what you are doing next.</preamble>"));

  const verbose = toolCallContract("json", "verbose");
  assert.match(verbose, /Always include a one-sentence preamble/);
  assert.ok(verbose.includes('"preamble":"One short sentence'));

  const quietReminder = toolTurnReminder({ format: "auto", preambleVerbosity: "quiet" });
  assert.match(quietReminder, /omit it for routine steps/);
  const normalReminder = toolTurnReminder({ format: "auto", preambleVerbosity: "normal" });
  assert.match(normalReminder, /saying what you are doing next, unless it is trivially implied/);
  const verboseReminder = toolTurnReminder({ format: "json", preambleVerbosity: "verbose" });
  assert.match(verboseReminder, /Include a short `preamble` saying what you are doing next\./);
});

test("contract re-application strips every verbosity variant", () => {
  for (const verbosity of ["quiet", "normal", "verbose"] as const) {
    const first = withToolCallContract(
      [{ role: "system" as const, content: "Be nice." }, { role: "user" as const, content: "hi" }],
      tools,
      "auto",
      true,
      "auto",
      verbosity,
    );
    // Re-apply with a different verbosity: no stale contract or reminder survives.
    const second = withToolCallContract(first, tools, "auto", true, "auto", verbosity === "quiet" ? "normal" : "quiet");
    const system = String(second[0]?.content);
    assert.equal(system.split("IMPORTANT ADAPTER OVERRIDE").length - 1, 1, `verbosity ${verbosity}`);
    assert.equal(system.split("Be nice.").length - 1, 1, `verbosity ${verbosity}`);
    const reminders = second.filter((message) =>
      message.role === "user" && String(message.content).startsWith("IMPORTANT TOOL TURN REMINDER:"));
    assert.equal(reminders.length, 1, `verbosity ${verbosity}`);
  }
});

test("the reminder follows the configured format", () => {
  const auto = toolTurnReminder({ required: true });
  assert.match(auto, /\{"type":"tool_calls"/);
  assert.match(auto, /<tool_calls>/);

  const xml = toolTurnReminder({ required: true, format: "xml" });
  assert.match(xml, /exactly one XML document/);
  assert.ok(!xml.includes('{"type":"tool_calls"'));

  const json = toolTurnReminder({ required: true, format: "json" });
  assert.match(json, /exactly one JSON object/);
});

test("contract re-application strips every format variant", () => {
  for (const format of ["auto", "json", "xml"] as const) {
    const first = withToolCallContract(
      [{ role: "system" as const, content: "Be nice." }, { role: "user" as const, content: "hi" }],
      tools,
      "auto",
      true,
      format,
    );
    // Re-apply in a different format: no stale contract or reminder survives.
    const second = withToolCallContract(first, tools, "auto", true, format === "xml" ? "json" : "xml");
    const system = String(second[0]?.content);
    assert.equal(system.split("IMPORTANT ADAPTER OVERRIDE").length - 1, 1, `format ${format}`);
    assert.equal(system.split("Be nice.").length - 1, 1, `format ${format}`);
    const reminders = second.filter((message) =>
      message.role === "user" && String(message.content).startsWith("IMPORTANT TOOL TURN REMINDER:"));
    assert.equal(reminders.length, 1, `format ${format}`);
  }
});
