import assert from "node:assert/strict";
import test from "node:test";
import {
  buildXmlSkeleton,
  coerceXmlValue,
  detectEnvelopeFormat,
  extractXmlCallNames,
  parseRepairXml,
  toolDefinitionsToXml,
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
  // The format XML-fluent models produce natively; a bare && is verbatim
  // value text, so the clean first pass needs no repair at all.
  const xml = [
    "<tool_calls>",
    '<tool_call name="bash">',
    '<parameter name="command">cd /c/Users/28018/Desktop/neuralwatt-ai && npx tsx --test tests/xml-tool-calls.test.ts 2>&1 | tail -30</parameter>',
    "</tool_call>",
    "</tool_calls>",
  ].join("\n");
  const result = parseControlledToolEnvelopeDetailed(xml, shellTools, "seed");
  assert.equal(result.envelope?.type, "tool_calls");
  assert.equal(result.repaired, undefined);
  if (result.envelope?.type !== "tool_calls") return;
  assert.equal(result.envelope.toolCalls[0]?.function.name, "bash");
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), {
    command: "cd /c/Users/28018/Desktop/neuralwatt-ai && npx tsx --test tests/xml-tool-calls.test.ts 2>&1 | tail -30",
  });
});

test("parameter elements carry JSON text; nested markup stays a raw string", () => {
  // Verbatim semantics: parameter content is always a raw string, so the old
  // nested-element notation arrives verbatim (schema validation rejects it
  // downstream and the repair loop corrects it to JSON text).
  const nested = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="bash"><parameter name="options"><verbose>true</verbose><retries>3</retries></parameter><parameter name="command">ls</parameter></tool_call></tool_calls>',
    shellTools,
    "seed",
  );
  assert.equal(nested.envelope?.type, "tool_calls");
  if (nested.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(nested.envelope.toolCalls[0]!.function.arguments), {
    options: "<verbose>true</verbose><retries>3</retries>",
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

test("malformed JSON inside parameter values is repaired like the JSON envelope", () => {
  const arraySchema = { type: "array", items: { type: "integer" } };
  // Trailing commas and single quotes are repaired, same as the JSON envelope.
  assert.deepEqual(coerceXmlValue("[1, 2,]", arraySchema as never), [1, 2]);
  assert.deepEqual(coerceXmlValue("['1', '2']", arraySchema as never), [1, 2]);
  // A truncated array is closed by the repair pass.
  assert.deepEqual(coerceXmlValue("[1, 2", arraySchema as never), [1, 2]);
  // Unrepairable text still falls back to the line/comma split (brackets are
  // not stripped by the split — that is the pre-existing fallback behavior).
  assert.deepEqual(coerceXmlValue("[1, 2, 3] extra", arraySchema as never), ["[1", 2, "3] extra"]);

  const objectSchema = {
    type: "object",
    properties: { verbose: { type: "boolean" }, retries: { type: "integer" } },
  };
  assert.deepEqual(coerceXmlValue("{verbose: true, retries: '3',}", objectSchema as never), { verbose: true, retries: 3 });
  // jsonrepair aggressively recovers even non-JSON text into an object; any
  // residual type mismatch is then reported by Ajv against the schema.
  assert.deepEqual(coerceXmlValue("{not json at all", objectSchema as never), { "not json at all": null });

  // Untyped schemas repair JSON-looking text too.
  assert.deepEqual(coerceXmlValue("{x: 1,}", undefined), { x: 1 });
  assert.equal(coerceXmlValue("007", undefined), "007");
});

test("malformed JSON text in <arguments> is repaired", () => {
  const result = parseControlledToolEnvelopeDetailed(
    "<tool_calls><tool_call><name>calculator</name><arguments>{a: 1, b: '2',}</arguments></tool_call></tool_calls>",
    tools,
    "seed",
  );
  assert.equal(result.envelope?.type, "tool_calls");
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { a: 1, b: 2 });
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

test("bare ampersands parse verbatim and CDATA content is still unwrapped", () => {
  const ampersand = parseControlledToolEnvelopeDetailed(
    "<tool_calls><tool_call><name>bash</name><arguments><command>echo a & b</command></arguments></tool_call></tool_calls>",
    shellTools,
    "seed",
  );
  assert.equal(ampersand.envelope?.type, "tool_calls");
  assert.equal(ampersand.repaired, undefined);
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

test("mis-nested tags are recovered with the stray close dropped", () => {
  // The scanner reads the call, drops the stray close tag, and keeps going;
  // the argument after the mis-nesting lands as a direct argument element.
  const result = parseRepairXml(
    "<tool_calls><tool_call><name>calculator</name><arguments><a>1</a></tool_call></arguments><b>2</b></tool_calls>",
  );
  assert.ok("value" in result);
  if (!("value" in result)) return;
  assert.equal(result.repaired, true);
  assert.ok(result.changes.some((change) => change.includes("stray")));
  const envelope = xmlDocToEnvelope(result.value, tools) as { tool_calls: { name: string; arguments: unknown }[] };
  assert.equal(envelope.tool_calls[0]?.name, "calculator");
  assert.deepEqual(envelope.tool_calls[0]?.arguments, { a: 1 });
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
  // Strict validation fails, txml throws on the mis-nested close, and the
  // scanner finds no complete call: the repair loop gets a located error.
  const result = parseRepairXml("<tool_calls></tool_call></tool_calls>");
  assert.ok(!("value" in result));
  if ("value" in result) return;
  assert.match(result.error, /could not be parsed/);
  assert.match(result.error, /line \d+, column \d+/);
  assert.match(result.error, />>>/);
  assert.match(result.error, /raw text/);
  // Diagnostics never suggest switching wire formats.
  assert.ok(!result.error.includes("switch"));
  assert.ok(!result.error.includes("JSON form"));
});

test("function-name-as-element calls are recovered when the name is declared", () => {
  // The observed deepseek-v4-pro failure mode: <bash>…</bash> instead of
  // <tool_call name="bash">…</tool_call>, with a raw && inside the value.
  // The old diagnostic blamed the & and the model looped on it forever.
  const candidate = "<tool_calls>\n<bash>\n<parameter name=\"command\" string=\"true\">git status && echo \"---DIFF---\" && git diff --stat</parameter>\n</bash>\n</tool_calls>";
  const result = parseRepairXml(candidate, new Set(["bash", "read"]));
  assert.ok("value" in result);
  if (!("value" in result)) return;
  assert.equal(result.repaired, true);
  assert.ok(result.changes.some((change) => change.includes('<tool_call name="bash">')));
  const envelope = xmlDocToEnvelope(result.value, shellTools) as { tool_calls: { name: string; arguments: unknown }[] };
  assert.equal(envelope.tool_calls[0]?.name, "bash");
  assert.deepEqual(envelope.tool_calls[0]?.arguments, { command: 'git status && echo "---DIFF---" && git diff --stat' });

  // The end-to-end path passes the declared tools through, so the repair
  // loop never sees this malformation at all.
  const detailed = parseControlledToolEnvelopeDetailed(candidate, shellTools, "seed");
  assert.equal(detailed.envelope?.type, "tool_calls");
  if (detailed.envelope?.type !== "tool_calls") return;
  assert.equal(detailed.envelope.toolCalls[0]?.function.name, "bash");
  assert.deepEqual(JSON.parse(detailed.envelope.toolCalls[0]!.function.arguments), {
    command: 'git status && echo "---DIFF---" && git diff --stat',
  });

  // Multiple sibling calls named by their elements are all recovered.
  const multiple = parseRepairXml(
    "<tool_calls><bash><parameter name=\"command\">ls</parameter></bash><read><parameter name=\"path\">a.ts</parameter></read></tool_calls>",
    new Set(["bash", "read"]),
  );
  assert.ok("value" in multiple);
  if (!("value" in multiple)) return;
  const wrapped = xmlDocToEnvelope(multiple.value, [...shellTools, ...tools]) as { tool_calls: { name: string }[] };
  assert.deepEqual(wrapped.tool_calls.map((call) => call.name), ["bash", "read"]);
});

test("a declared tool name in prose does not hijack a valid envelope", () => {
  // The second scanner pass only runs when the strict pass found no call, so
  // angle-bracket prose beside a valid envelope is still ignored.
  const candidate = "Using <bash> for this.\n<tool_calls><tool_call name=\"bash\"><parameter name=\"command\">ls</parameter></tool_call></tool_calls>";
  const result = parseRepairXml(candidate, new Set(["bash"]));
  assert.ok("value" in result);
  if (!("value" in result)) return;
  const envelope = xmlDocToEnvelope(result.value, shellTools) as { tool_calls: { name: string; arguments: unknown }[] };
  assert.equal(envelope.tool_calls.length, 1);
  assert.deepEqual(envelope.tool_calls[0]?.arguments, { command: "ls" });
});

test("the diagnostic names the function-name-as-element malformation", () => {
  // Without declared names the scanner cannot recover <bash>…</bash>; the
  // diagnostic must name the real problem instead of blaming the raw &.
  const result = parseRepairXml("<tool_calls>\n<bash>\n<parameter name=\"command\">git status && git diff</parameter>\n</bash>\n</tool_calls>");
  assert.ok(!("value" in result));
  if ("value" in result) return;
  assert.match(result.error, /<bash> is not a tool call/);
  assert.match(result.error, /<tool_call name="bash">/);
  assert.match(result.error, /raw & inside a <parameter> value needs no escaping/);
});

test("well-formed XML without a tool call is reported honestly", () => {
  // The model's misguided "fix" (&& → ;) is valid XML, so the diagnostic
  // must not claim a parse failure — the missing <tool_call> is the problem.
  const result = parseRepairXml("<tool_calls>\n<bash>\n<parameter name=\"command\">git status; git diff</parameter>\n</bash>\n</tool_calls>");
  assert.ok(!("value" in result));
  if ("value" in result) return;
  assert.match(result.error, /well-formed, but no tool call was found/);
  assert.match(result.error, /<bash> is not a tool call/);
  assert.ok(!result.error.includes("tolerant txml parser also failed"));
});

test("extractXmlCallNames lifts names used as element names", () => {
  const declared = new Set(["bash", "read"]);
  const names = extractXmlCallNames(
    "<tool_calls><bash><parameter name=\"command\">ls</parameter></bash></tool_calls>",
    declared,
  );
  assert.deepEqual(names, ["bash"]);
});

test("the envelope scanner recovers raw markup, stray close tags and alias closes", () => {
  // The observed DeepSeek failure mode: the edits value carries Vue template
  // code with raw `<` and embedded elements, followed by a duplicate
  // </parameter> and an alias </invoke> close.
  const editTools: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "edit",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { oldText: { type: "string" }, newText: { type: "string" } },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  }];
  const edits = JSON.stringify([{
    oldText: '<span class="status-chip" :class="item.record.status < 400 ? \'ok\' : \'err\'">{{ item.record.status }}</span>',
    newText: '<span v-if="item.record.model" class="trace-model" :title="item.record.model">{{ item.record.model }}</span>',
  }]);
  const content = [
    "<tool_calls>",
    '<tool_call name="edit">',
    '<parameter name="path">app/App.vue</parameter>',
    `<parameter name="edits">${edits}</parameter>`,
    "</parameter>",
    "</invoke>",
    "</tool_calls>",
  ].join("\n");
  const result = parseControlledToolEnvelopeDetailed(content, editTools, "seed");
  assert.equal(result.error, undefined);
  assert.equal(result.envelope?.type, "tool_calls");
  if (result.envelope?.type !== "tool_calls") return;
  assert.equal(result.envelope.toolCalls.length, 1);
  assert.equal(result.envelope.toolCalls[0]?.function.name, "edit");
  const args = JSON.parse(result.envelope.toolCalls[0]!.function.arguments);
  assert.equal(args.path, "app/App.vue");
  assert.equal(args.edits.length, 1);
  // The parameter value survived verbatim: raw `<` and embedded markup intact.
  assert.ok(args.edits[0].oldText.includes("< 400"));
  assert.ok(args.edits[0].newText.includes('<span v-if="item.record.model"'));
});

test("a tolerant parse that corrupts markup-bearing parameters falls back to the scanner", () => {
  // The observed DeepSeek first-pass failure: the edits value is JSON text
  // embedding real-looking tags. txml parses it "successfully" but turns the
  // embedded tags into elements and discards the surrounding JSON text; the
  // mixed-content signature must reroute to the envelope scanner, which reads
  // parameter content as raw text.
  const editTools: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "edit_file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { oldText: { type: "string" }, newText: { type: "string" } },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  }];
  const content = '<tool_calls><tool_call name="edit_file"><parameter name="path">server/schema.xml</parameter>'
    + '<parameter name="edits">[{"oldText": "<parameter name=\\"value\\">0</parameter>", "newText": "<parameter name=\\"value\\">1</parameter>"}]</parameter>'
    + "</tool_call></tool_calls>";
  const result = parseControlledToolEnvelopeDetailed(content, editTools, "seed");
  assert.equal(result.error, undefined);
  assert.equal(result.envelope?.type, "tool_calls");
  if (result.envelope?.type !== "tool_calls") return;
  const args = JSON.parse(result.envelope.toolCalls[0]!.function.arguments);
  assert.equal(args.path, "server/schema.xml");
  assert.equal(args.edits.length, 1);
  assert.equal(args.edits[0].oldText, '<parameter name="value">0</parameter>');
  assert.equal(args.edits[0].newText, '<parameter name="value">1</parameter>');
});

test("the envelope scanner reads values verbatim and still unwraps CDATA", () => {
  const content = [
    "<tool_calls>",
    '<tool_call name="calculator">',
    '<parameter name="a">1 &lt; 2</parameter>',
    "<parameter name=\"b\"><![CDATA[3 > 2 && 1 < 4]]></parameter>",
    "</tool_call>",
    "</tool_calls>",
  ].join("\n");
  // A stray duplicate close tag is dropped, not absorbed into the value.
  const broken = content.replace("</tool_call>", "</parameter>\n</tool_call>");
  const result = parseControlledToolEnvelopeDetailed(broken, tools, "seed");
  assert.equal(result.error, undefined);
  assert.equal(result.envelope?.type, "tool_calls");
  assert.equal(result.repaired, true);
  if (result.envelope?.type !== "tool_calls") return;
  const args = JSON.parse(result.envelope.toolCalls[0]!.function.arguments);
  // Verbatim: entity references are literal text, never decoded.
  assert.equal(args.a, "1 &lt; 2");
  // CDATA from older contracts is still unwrapped (its content is verbatim).
  assert.equal(args.b, "3 > 2 && 1 < 4");
});

test("an embedded close tag without a structural continuation is value text", () => {
  // <parameter name="command">aaa</parameter>bbb</parameter> parses as
  // aaa</parameter>bbb: the first close is followed by plain text, so it is
  // part of the value; the second is followed by the call close.
  const result = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="bash"><parameter name="command">aaa</parameter>bbb</parameter></tool_call></tool_calls>',
    shellTools,
    "seed",
  );
  assert.equal(result.error, undefined);
  assert.equal(result.repaired, undefined);
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { command: "aaa</parameter>bbb" });
});

test("sibling parameters still terminate at their own close tags", () => {
  const result = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="calculator"><parameter name="a">1</parameter><parameter name="b">2</parameter></tool_call></tool_calls>',
    tools,
    "seed",
  );
  assert.equal(result.error, undefined);
  assert.equal(result.repaired, undefined);
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), { a: 1, b: 2 });
});

test("stray special-token artifacts after a close tag are ignored", () => {
  // The observed failure mode: the model closes the parameter, then emits
  // stray special-token artifacts (</｜DSML｜>) instead of the call close.
  // The structural level accepts only known tags, so the artifacts are
  // ignored and the value ends at its own close tag.
  const result = parseControlledToolEnvelopeDetailed(
    [
      "<tool_calls>",
      '<tool_call name="bash">',
      '<parameter name="command">git ls-files | xargs grep -il "neuralwatt" | wc -l</parameter>',
      "</｜DSML｜>",
      "</｜DSML｜>",
      "</｜DSML｜>",
    ].join("\n"),
    shellTools,
    "seed",
  );
  assert.equal(result.error, undefined);
  assert.equal(result.repaired, true);
  assert.equal(result.envelope?.type, "tool_calls");
  if (result.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(result.envelope.toolCalls[0]!.function.arguments), {
    command: 'git ls-files | xargs grep -il "neuralwatt" | wc -l',
  });

  // The same artifacts before a real call close parse with no repair at all.
  const clean = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="bash"><parameter name="command">ls</parameter></｜DSML｜></tool_call></tool_calls>',
    shellTools,
    "seed",
  );
  assert.equal(clean.error, undefined);
  assert.equal(clean.repaired, undefined);
  if (clean.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(clean.envelope.toolCalls[0]!.function.arguments), { command: "ls" });
});

test("a close tag followed by trailing text terminates at the last close", () => {
  // <B>aaa</B>bbb parses as aaa: the trailing text carries no later close
  // tag, so it is ignored junk rather than value text.
  const trailing = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="bash"><parameter name="command">aaa</parameter>bbb</tool_call></tool_calls>',
    shellTools,
    "seed",
  );
  assert.equal(trailing.error, undefined);
  assert.equal(trailing.envelope?.type, "tool_calls");
  if (trailing.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(trailing.envelope.toolCalls[0]!.function.arguments), { command: "aaa" });

  // <B>aa<B>aaa</B>bbb parses as aa<B>aaa: a nested open tag is value text.
  const nested = parseControlledToolEnvelopeDetailed(
    '<tool_calls><tool_call name="bash"><parameter name="command">aa<parameter name="x">aaa</parameter>bbb</tool_call></tool_calls>',
    shellTools,
    "seed",
  );
  assert.equal(nested.error, undefined);
  assert.equal(nested.envelope?.type, "tool_calls");
  if (nested.envelope?.type !== "tool_calls") return;
  assert.deepEqual(JSON.parse(nested.envelope.toolCalls[0]!.function.arguments), { command: 'aa<parameter name="x">aaa' });
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

test("unrecognized content gets a format-neutral error without switch hints", () => {
  const result = parseControlledToolEnvelopeDetailed("just plain prose, no envelope at all", tools, "seed");
  assert.equal(result.envelope, undefined);
  assert.match(result.error ?? "", /not recognized as a tool-call envelope/);
  // The error stays format-neutral: it names neither envelope skeleton and
  // never suggests switching formats.
  assert.ok(!result.error?.includes("JSON form"));
  assert.ok(!result.error?.includes("switch"));
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

test("history tool calls are re-encoded in the contract's wire format", () => {
  const history = [
    { role: "user" as const, content: "calc" },
    {
      role: "assistant" as const,
      content: "Computing now.",
      tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "calculator", arguments: '{"a":1,"b":2}' } }],
    },
    { role: "tool" as const, tool_call_id: "call_1", content: "3" },
  ];

  // A pinned XML contract must not leave JSON envelopes in the history: the
  // model imitates the format it sees.
  const xml = withToolCallContract(history, tools, "auto", true, "xml");
  const xmlAssistant = xml.find((message) => message.role === "assistant");
  assert.equal(
    xmlAssistant?.content,
    '<tool_calls><preamble>Computing now.</preamble><tool_call name="calculator"><parameter name="a">1</parameter><parameter name="b">2</parameter></tool_call></tool_calls>',
  );
  assert.equal(xmlAssistant?.tool_calls, undefined);

  // JSON and auto keep the canonical JSON envelope.
  for (const format of ["json", "auto"] as const) {
    const contracted = withToolCallContract(history, tools, "auto", true, format);
    const assistant = contracted.find((message) => message.role === "assistant");
    const envelope = JSON.parse(String(assistant?.content));
    assert.equal(envelope.type, "tool_calls", format);
    assert.equal(envelope.preamble, "Computing now.", format);
    assert.deepEqual(envelope.tool_calls, [{ name: "calculator", arguments: { a: 1, b: 2 } }], format);
  }
});

test("XML history re-encoding writes markup-bearing values raw", () => {
  const history = [
    { role: "user" as const, content: "calc" },
    {
      role: "assistant" as const,
      content: "5 < 6 & 7 > 4",
      tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "calculator", arguments: '{"a":1,"b":2}' } }],
    },
  ];
  const contracted = withToolCallContract(history, tools, "auto", true, "xml");
  const assistant = contracted.find((message) => message.role === "assistant");
  // Values are raw text parsed verbatim: the history models exactly what the
  // contract asks the model to emit — no CDATA, no escaping.
  assert.equal(
    assistant?.content,
    '<tool_calls><preamble>5 < 6 & 7 > 4</preamble><tool_call name="calculator"><parameter name="a">1</parameter><parameter name="b">2</parameter></tool_call></tool_calls>',
  );
});

test("raw history values round-trip, including ]]> and an embedded close tag", () => {
  const editTools: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "edit_file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { oldText: { type: "string" }, newText: { type: "string" } },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  }];
  const edits = [{ oldText: "a < b & c]]>d</parameter>e", newText: '<span v-if="x">{{ y }}</span>' }];
  const history = [
    { role: "user" as const, content: "edit" },
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "edit_file", arguments: JSON.stringify({ path: "a.vue", edits }) } }],
    },
    { role: "tool" as const, tool_call_id: "call_1", content: "ok" },
  ];
  const contracted = withToolCallContract(history, editTools, "auto", true, "xml");
  const assistant = contracted.find((message) => message.role === "assistant");
  const content = String(assistant?.content);
  // No CDATA anywhere: values are written raw.
  assert.ok(!content.includes("<![CDATA["));
  // The re-encoded history parses back to the exact original arguments.
  const parsed = parseControlledToolEnvelopeDetailed(content, editTools, "seed");
  assert.equal(parsed.error, undefined);
  if (parsed.envelope?.type !== "tool_calls") return;
  const args = JSON.parse(parsed.envelope.toolCalls[0]!.function.arguments);
  assert.deepEqual(args, { path: "a.vue", edits });
});

test("contract re-application strips every verbosity variant", () => {
  for (const verbosity of ["quiet", "normal", "verbose", "milestone"] as const) {
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

test("map-typed parameters keep string values through XML conversion", () => {
  const mapTools: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "run_command",
      parameters: {
        type: "object",
        properties: {
          env: { type: "object", minProperties: 2, additionalProperties: { type: "string" } },
          timeout_ms: { type: "integer" },
        },
        required: ["env", "timeout_ms"],
      },
    },
  }];
  const xml = '<tool_calls><tool_call name="run_command">'
    + '<parameter name="env">{"CI":"true","SUITE":"smoke"}</parameter>'
    + '<parameter name="timeout_ms">15000</parameter>'
    + '</tool_call></tool_calls>';
  const parsed = parseRepairXml(xml);
  assert.ok(!("error" in parsed));
  const envelope = xmlDocToEnvelope(parsed.value, mapTools) as {
    tool_calls: { name: string; arguments: Record<string, unknown> }[];
  };
  const args = envelope.tool_calls[0]?.arguments;
  // additionalProperties declares the map value type: "true" stays a string
  // instead of falling into the untyped boolean coercion.
  assert.deepEqual(args?.env, { CI: "true", SUITE: "smoke" });
  assert.equal(args?.timeout_ms, 15000);
});

test("XML coercion respects patternProperties value schemas", () => {
  const schema = { type: "object", patternProperties: { "^x-": { type: "string" } } };
  assert.deepEqual(coerceXmlValue({ "x-flag": "true" }, schema as never), { "x-flag": "true" });
});

test("tool definitions render as an XML schema document", () => {
  const xml = toolDefinitionsToXml(shellTools);
  assert.match(xml, /^<functions>/);
  assert.match(xml, /<\/functions>$/);
  assert.match(xml, /<function name="bash">/);
  assert.match(xml, /<description>Run a shell command<\/description>/);
  assert.match(xml, /<parameter name="command" type="string" required="true"\/>/);
  assert.match(xml, /<parameter name="timeout" type="integer"\/>/);
  assert.match(xml, /<parameter name="flags" type="array">/);
  assert.match(xml, /<items type="string"\/>/);
  assert.match(xml, /<property name="verbose" type="boolean"\/>/);
  // No JSON schema notation leaks into the XML rendering.
  assert.ok(!xml.includes('"type"'));
});

test("tool definition XML keeps enums, constraints and map value types", () => {
  const complexTools: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "run_command",
      parameters: {
        type: "object",
        properties: {
          shell: { type: "string", enum: ["bash", "sh"] },
          env: { type: "object", minProperties: 2, additionalProperties: { type: "string" } },
          pattern: { type: "string", pattern: "^[a-z]+$" },
        },
        required: ["shell"],
        additionalProperties: false,
      },
    },
  }];
  const xml = toolDefinitionsToXml(complexTools);
  // The root <parameters> element elides the uniform type="object" boilerplate.
  assert.match(xml, /<parameters additionalProperties="false">/);
  assert.match(xml, /<value>bash<\/value>/);
  assert.match(xml, /<parameter name="env" type="object" minProperties="2">/);
  assert.match(xml, /<additionalProperties type="string"\/>/);
  assert.ok(xml.includes('pattern="^[a-z]+$"'));
});

test("the pinned XML contract sends XML tool definitions, not JSON", () => {
  const contracted = withToolCallContract([{ role: "user" as const, content: "hi" }], tools, "auto", true, "xml");
  const system = String(contracted.find((message) => message.role === "system")?.content);
  assert.ok(system.includes("Declared functions and their XML Schemas:"));
  assert.ok(system.includes('<function name="calculator">'));
  assert.ok(!system.includes("Declared functions and their complete JSON Schemas:"));
  assert.ok(system.includes("declared XML schema"));

  const json = withToolCallContract([{ role: "user" as const, content: "hi" }], tools, "auto", true, "json");
  const jsonSystem = String(json.find((message) => message.role === "system")?.content);
  assert.ok(jsonSystem.includes("Declared functions and their complete JSON Schemas:"));
  assert.ok(!jsonSystem.includes("<functions>"));
});

test("re-application strips the XML schema block from history", () => {
  const first = withToolCallContract(
    [{ role: "system" as const, content: "Be nice." }, { role: "user" as const, content: "hi" }],
    tools,
    "auto",
    true,
    "xml",
  );
  const second = withToolCallContract(first, tools, "auto", true, "json");
  const system = String(second[0]?.content);
  assert.ok(!system.includes("Declared functions and their XML Schemas:"));
  assert.ok(!system.includes("<functions>"));
  assert.equal(system.split("IMPORTANT ADAPTER OVERRIDE").length - 1, 1);
  assert.equal(system.split("Be nice.").length - 1, 1);
});
