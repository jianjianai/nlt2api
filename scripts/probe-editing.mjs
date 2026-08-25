// Error-prone file-editing tool-call probe: complex payloads, embedded markup,
// parallel calls, CJK, regex, long files. Usage:
//   node scripts/probe-editing.mjs <model> <turnsPerScenario>
// Requires DEEPINFRA_PROBE_CLIENT_KEY; optional DEEPINFRA_PROBE_BASE_URL.
const baseUrl = process.env.DEEPINFRA_PROBE_BASE_URL || "http://localhost:3000";
const clientKey = process.env.DEEPINFRA_PROBE_CLIENT_KEY;
const model = process.argv[2] || "deepseek-v4-pro";
const turnsPerScenario = Number(process.argv[3] || "1");
const runId = `editing-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const editSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    edits: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  required: ["path", "edits"],
  additionalProperties: false,
};

const writeSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    content: { type: "string" },
    encoding: { type: "string", enum: ["utf8", "ascii"] },
  },
  required: ["path", "content"],
  additionalProperties: false,
};

const scenarios = [
  {
    name: "vue_markup_edit",
    tool: "edit_file",
    schema: editSchema,
    prompt: `Edit app/App.vue: replace exactly '<span class="status-chip">{{ status }}</span>' with '<span class="status-chip" :class="status < 400 ? \'ok\' : \'err\'">{{ status }}</span>'. Call edit_file.`,
    checks: (args) => {
      if (args.path !== "app/App.vue") return "path mismatch";
      const edit = args.edits?.[0];
      if (!edit) return "no edits";
      if (!String(edit.newText).includes("< 400")) return "newText lost the raw `< 400`";
      if (!String(edit.newText).includes("status-chip")) return "newText lost markup";
      return null;
    },
  },
  {
    name: "html_template_write",
    tool: "write_file",
    schema: writeSchema,
    prompt: `Write public/index.html with exactly this content: '<!DOCTYPE html><html><head><title>A & B</title></head><body><p>1 < 2 and 5 > 4</p></body></html>'. Call write_file with encoding utf8.`,
    checks: (args) => {
      if (!String(args.content).includes("A & B")) return "lost `A & B`";
      if (!String(args.content).includes("1 < 2 and 5 > 4")) return "lost raw comparison operators";
      if (args.encoding !== "utf8") return "encoding mismatch";
      return null;
    },
  },
  {
    name: "multi_edit_batch",
    tool: "edit_file",
    schema: editSchema,
    prompt: "Edit src/config.ts with exactly 4 edits in one call: (1) oldText 'const A = 1;' newText 'const A = 2;'; (2) oldText 'const B = 1;' newText 'const B = 2;'; (3) oldText 'const C = 1;' newText 'const C = 2;'; (4) oldText 'const D = 1;' newText 'const D = 2;'. Call edit_file.",
    checks: (args) => {
      if (!Array.isArray(args.edits) || args.edits.length !== 4) return `expected 4 edits, got ${args.edits?.length}`;
      const second = args.edits[1];
      if (second?.oldText !== "const B = 1;" || second?.newText !== "const B = 2;") return "edit 2 mismatch";
      return null;
    },
  },
  {
    name: "regex_edit",
    tool: "edit_file",
    schema: editSchema,
    prompt: `Edit src/utils.ts: replace 'const pattern = /\\d+/;' with 'const pattern = /\\d{2,4}\\s*<\\/?\\w+>/g;'. Call edit_file.`,
    checks: (args) => {
      const edit = args.edits?.[0];
      if (!edit) return "no edits";
      if (!String(edit.newText).includes("\\d{2,4}")) return "lost regex quantifier";
      if (!String(edit.newText).includes("<\\/?\\w+>")) return "lost regex tag pattern";
      return null;
    },
  },
  {
    name: "cjk_edit",
    tool: "edit_file",
    schema: editSchema,
    prompt: "Edit docs/readme.md: replace '标题' with '标题：工具调用（JSON/XML）与「信封」'. Call edit_file.",
    checks: (args) => {
      const edit = args.edits?.[0];
      if (!edit) return "no edits";
      if (!String(edit.newText).includes("工具调用（JSON/XML）")) return "lost CJK/full-width content";
      if (!String(edit.newText).includes("「信封」")) return "lost corner brackets";
      return null;
    },
  },
  {
    name: "json_config_write",
    tool: "write_file",
    schema: writeSchema,
    prompt: `Write config/settings.json with content '{"nested":{"list":[1,2,3],"flag":true,"note":"a<b"}}'. Call write_file.`,
    checks: (args) => {
      try {
        const parsed = JSON.parse(String(args.content));
        if (parsed.nested?.flag !== true) return "lost boolean";
        if (parsed.nested?.note !== "a<b") return "lost `a<b` in JSON string";
        return null;
      } catch {
        return "content is not valid JSON";
      }
    },
  },
  {
    name: "long_file_write",
    tool: "write_file",
    schema: writeSchema,
    prompt: "Write src/lines.ts whose content is exactly 40 lines: line 1 is 'export const L01 = 1;', line 2 is 'export const L02 = 2;', and so on up to 'export const L40 = 40;'. Call write_file.",
    checks: (args) => {
      const content = String(args.content);
      if (!content.includes("export const L01 = 1;")) return "missing first line";
      if (!content.includes("export const L40 = 40;")) return "missing last line (truncation?)";
      if (!content.includes("export const L25 = 25;")) return "missing middle line";
      return null;
    },
  },
  {
    name: "xml_code_edit",
    tool: "edit_file",
    schema: editSchema,
    prompt: `Edit server/schema.xml: replace '<parameter name="value">0</parameter>' with '<parameter name="value">1</parameter>'. Call edit_file.`,
    checks: (args) => {
      const edit = args.edits?.[0];
      if (!edit) return "no edits";
      if (!String(edit.oldText).includes('<parameter name="value">0</parameter>')) return "oldText lost XML markup";
      if (!String(edit.newText).includes('<parameter name="value">1</parameter>')) return "newText lost XML markup";
      return null;
    },
  },
];

const parallelScenario = {
  name: "parallel_edits",
  prompt: "Do all three edits now, in parallel: edit a.txt replacing 'a=1' with 'a=2'; edit b.txt replacing 'b=1' with 'b=2'; edit c.txt replacing 'c=1' with 'c=2'. Make three edit_file calls in one response.",
  tools: [{ name: "edit_file", schema: editSchema }],
  checks: (calls) => {
    if (calls.length !== 3) return `expected 3 parallel calls, got ${calls.length}`;
    const paths = calls.map((call) => call.args.path).sort();
    if (paths.join(",") !== "a.txt,b.txt,c.txt") return `paths: ${paths.join(",")}`;
    return null;
  },
};

function parseSse(text) {
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    frames.push(JSON.parse(data));
  }
  return frames;
}

function collectToolCalls(frames) {
  const byIndex = new Map();
  for (const frame of frames) {
    for (const call of frame.choices?.[0]?.delta?.tool_calls || []) {
      const key = call.index ?? 0;
      const entry = byIndex.get(key) || { name: undefined, arguments: "" };
      if (call.function?.name) entry.name = call.function.name;
      if (call.function?.arguments) entry.arguments += call.function.arguments;
      byIndex.set(key, entry);
    }
  }
  return [...byIndex.values()].map((entry) => {
    let args;
    try {
      args = JSON.parse(entry.arguments);
    } catch {
      args = undefined;
    }
    return { name: entry.name, args, rawArguments: entry.arguments };
  });
}

async function runTurn(scenario, turn) {
  const isParallel = scenario.name === "parallel_edits";
  const body = {
    model,
    messages: [{ role: "user", content: `${scenario.prompt} (probe ${runId} turn ${turn})` }],
    tools: (isParallel ? scenario.tools : [{ name: scenario.tool, schema: scenario.schema }]).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: "A deterministic local agent test function.",
        parameters: tool.schema,
        strict: true,
      },
    })),
    tool_choice: isParallel ? "required" : { type: "function", function: { name: scenario.tool } },
    parallel_tool_calls: true,
    temperature: 0,
    max_completion_tokens: 4096,
    stream: true,
    user: `${runId}-${scenario.name}-${turn}`,
  };
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  }
  const calls = collectToolCalls(parseSse(text));
  if (calls.length === 0) {
    return { ok: false, error: "no tool calls in response" };
  }
  if (calls.some((call) => call.args === undefined)) {
    return { ok: false, error: `arguments JSON.parse failed: ${calls[0]?.rawArguments?.slice(0, 120)}` };
  }
  if (isParallel) {
    const error = scenario.checks(calls);
    return error ? { ok: false, error } : { ok: true };
  }
  const call = calls[0];
  if (call.name !== scenario.tool) {
    return { ok: false, error: `tool mismatch: ${call.name}` };
  }
  const error = scenario.checks(call.args);
  return error ? { ok: false, error } : { ok: true };
}

const results = [];
for (const scenario of [...scenarios, parallelScenario]) {
  for (let turn = 1; turn <= turnsPerScenario; turn += 1) {
    const started = Date.now();
    try {
      const result = await runTurn(scenario, turn);
      results.push({ scenario: scenario.name, turn, ms: Date.now() - started, ...result });
      console.log(`${result.ok ? "PASS" : "FAIL"} ${scenario.name}#${turn} ${Date.now() - started}ms${result.error ? ` — ${result.error}` : ""}`);
    } catch (error) {
      results.push({ scenario: scenario.name, turn, ok: false, error: String(error) });
      console.log(`FAIL ${scenario.name}#${turn} — ${String(error).slice(0, 160)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({
  runId,
  model,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((result) => ({ scenario: result.scenario, turn: result.turn, error: result.error })),
}, null, 2));
