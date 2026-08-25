/**
 * Complex-scenario tool-call probe: measures per-model first-pass accuracy
 * for the controlled tool-call envelope under realistic agent workloads:
 *   - edit_file:    multiple disjoint edits carrying <, >, &, quotes (CDATA stress)
 *   - run_command:  piped/redirected shell command with quotes and an env map
 *   - write_file:   HTML/JS document with markup, && and template literals
 *   - batch turn:   three calls in one envelope under tool_choice "required"
 *
 * Metrics come from the server-side toolCallAdapter debug records (initial
 * parse + schema validation outcome), plus a client-side semantic check that
 * the returned arguments match what the prompt requested.
 *
 * Required env: DEEPINFRA_PROBE_ADMIN_TOKEN, DEEPINFRA_PROBE_CLIENT_KEY,
 * DEEPINFRA_PROBE_EMAIL, DEEPINFRA_PROBE_PASSWORD.
 * Optional env: DEEPINFRA_PROBE_BASE_URL, DEEPINFRA_PROBE_ACCOUNT_ID (reuse
 * an existing account instead of creating one), DEEPINFRA_PROBE_MODEL,
 * DEEPINFRA_PROBE_TURNS, DEEPINFRA_PROBE_DELAY_MS,
 * DEEPINFRA_PROBE_TEMPERATURE, DEEPINFRA_PROBE_REQUIRE_FIRST_PASS.
 */
const baseUrl = process.env.DEEPINFRA_PROBE_BASE_URL || "http://localhost:3000";
const adminToken = process.env.DEEPINFRA_PROBE_ADMIN_TOKEN;
const clientKey = process.env.DEEPINFRA_PROBE_CLIENT_KEY;
const email = process.env.DEEPINFRA_PROBE_EMAIL;
const password = process.env.DEEPINFRA_PROBE_PASSWORD;
const total = Number.parseInt(process.env.DEEPINFRA_PROBE_TURNS || "20", 10);
const delayMs = Number.parseInt(process.env.DEEPINFRA_PROBE_DELAY_MS || "3000", 10);
const model = process.env.DEEPINFRA_PROBE_MODEL || "kimi-k3-fast";
const temperature = Number(process.env.DEEPINFRA_PROBE_TEMPERATURE ?? "0");
const requireFirstPassThreshold = process.env.DEEPINFRA_PROBE_REQUIRE_FIRST_PASS !== "false";

for (const [name, value] of Object.entries({ adminToken, clientKey, email, password })) {
  if (!value) {
    throw new Error(`Missing required probe setting: ${name}`);
  }
}
if (!Number.isInteger(total) || total < 1 || total > 100) {
  throw new Error("DEEPINFRA_PROBE_TURNS must be an integer from 1 to 100.");
}

const adminHeaders = {
  "content-type": "application/json",
  "x-admin-token": adminToken,
};
const clientHeaders = {
  authorization: `Bearer ${clientKey}`,
  "content-type": "application/json",
};
const runId = `complex-${crypto.randomUUID().replaceAll("-", "")}`;
let accountId;
let previousRecordMessages;

const EDIT_FILE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9_./-]+$" },
    edits: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
    options: {
      type: "object",
      properties: {
        encoding: { type: "string", enum: ["utf8", "ascii"] },
        create_backup: { type: "boolean" },
      },
      required: ["encoding", "create_backup"],
      additionalProperties: false,
    },
  },
  required: ["path", "edits", "options"],
  additionalProperties: false,
};

const RUN_COMMAND_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    command: { type: "string", minLength: 3 },
    cwd: { type: "string", minLength: 1 },
    env: {
      type: "object",
      minProperties: 2,
      additionalProperties: { type: "string" },
    },
    timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
    shell: { type: "string", enum: ["bash", "sh", "pwsh"] },
  },
  required: ["command", "cwd", "env", "timeout_ms", "shell"],
  additionalProperties: false,
};

const WRITE_FILE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9_./-]+$" },
    content: { type: "string", minLength: 20 },
    mode: { type: "string", enum: ["create", "overwrite", "append"] },
    make_parents: { type: "boolean" },
  },
  required: ["path", "content", "mode", "make_parents"],
  additionalProperties: false,
};

const READ_FILE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9_./-]+$" },
    offset: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 2000 },
  },
  required: ["path"],
  additionalProperties: false,
};

const WRITE_CONTENT = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  '  <head><meta charset="utf-8"><title>Probe & Test</title></head>',
  "  <body>",
  '    <script type="module">',
  "      const ok = a < b && c > d;",
  '      console.log(`result: ${ok ? "yes" : "no"}`);',
  "    </script>",
  "  </body>",
  "</html>",
].join("\n");

function tool(name, schema) {
  return {
    type: "function",
    function: {
      name,
      description: "A deterministic local agent test function.",
      parameters: schema,
      strict: true,
    },
  };
}

const variants = [
  {
    name: "edit_file",
    tools: [tool("edit_file", EDIT_FILE_SCHEMA)],
    toolChoice: { type: "function", function: { name: "edit_file" } },
    parallel: false,
    prompt: [
      "Call edit_file for src/utils/compare.ts with exactly three edits, encoding utf8, create_backup false.",
      'Edit 1: replace `if (a < b && c > d) {` with `if (a <= b && c >= d) {`.',
      'Edit 2: replace `return render(<div className="app">{items}</div>);` with `return render(<section className="app">{items}</section>);`.',
      'Edit 3: replace `const re = /["\']|&/g;` with `const re = /["\']|&amp;/g;`.',
    ].join(" "),
    expect(calls) {
      if (calls.length !== 1 || calls[0].name !== "edit_file") return "expected exactly one edit_file call";
      const args = calls[0].args;
      if (args.path !== "src/utils/compare.ts") return `path mismatch: ${args.path}`;
      if (!Array.isArray(args.edits) || args.edits.length !== 3) return "expected exactly 3 edits";
      if (!String(args.edits[1]?.newText || "").includes("<section")) return "edit 2 newText mismatch";
      if (!String(args.edits[2]?.newText || "").includes("&amp;")) return "edit 3 newText mismatch";
      if (args.options?.encoding !== "utf8" || args.options?.create_backup !== false) return "options mismatch";
      return undefined;
    },
  },
  {
    name: "run_command",
    tools: [tool("run_command", RUN_COMMAND_SCHEMA)],
    toolChoice: { type: "function", function: { name: "run_command" } },
    parallel: false,
    prompt: [
      "Call run_command with shell bash, cwd /workspace/app, timeout_ms 30000,",
      "env CI=true and LOG_LEVEL=debug, and exactly this command:",
      'grep -rn "TODO\\|FIXME" src/ --include="*.ts" | head -20 && echo "scan done" > reports/scan.txt',
    ].join(" "),
    expect(calls) {
      if (calls.length !== 1 || calls[0].name !== "run_command") return "expected exactly one run_command call";
      const args = calls[0].args;
      const command = String(args.command || "");
      if (!command.includes("grep") || !command.includes("&&") || !command.includes(">")) return `command mismatch: ${command}`;
      if (args.env?.CI !== "true" || args.env?.LOG_LEVEL !== "debug") return "env mismatch";
      if (args.timeout_ms !== 30000 || args.shell !== "bash" || args.cwd !== "/workspace/app") return "scalar fields mismatch";
      return undefined;
    },
  },
  {
    name: "write_file",
    tools: [tool("write_file", WRITE_FILE_SCHEMA)],
    toolChoice: { type: "function", function: { name: "write_file" } },
    parallel: false,
    prompt: [
      "Call write_file for web/index.html, mode overwrite, make_parents true, with exactly this content:",
      "```",
      WRITE_CONTENT,
      "```",
    ].join("\n"),
    expect(calls) {
      if (calls.length !== 1 || calls[0].name !== "write_file") return "expected exactly one write_file call";
      const args = calls[0].args;
      const content = String(args.content || "");
      if (args.path !== "web/index.html") return `path mismatch: ${args.path}`;
      if (!content.includes("<!DOCTYPE html>") || !content.includes("&&") || !content.includes("${ok")) return "content mismatch";
      if (args.mode !== "overwrite" || args.make_parents !== true) return "scalar fields mismatch";
      return undefined;
    },
  },
  {
    name: "batch_read_and_run",
    tools: [tool("read_file", READ_FILE_SCHEMA), tool("run_command", RUN_COMMAND_SCHEMA)],
    toolChoice: "required",
    parallel: true,
    prompt: [
      "Do all three actions in a single response: call read_file for package.json (offset 1, limit 40),",
      "call read_file for src/index.ts (whole file), and call run_command with shell bash, cwd /workspace,",
      "timeout_ms 15000, env CI=true and SUITE=smoke, command:",
      'find src -name "*.test.ts" | sort | head -10',
    ].join(" "),
    expect(calls) {
      if (calls.length !== 3) return `expected 3 calls, got ${calls.length}`;
      const reads = calls.filter((call) => call.name === "read_file");
      const runs = calls.filter((call) => call.name === "run_command");
      if (reads.length !== 2 || runs.length !== 1) return "expected 2 read_file + 1 run_command";
      const paths = reads.map((call) => call.args.path).sort();
      if (paths[0] !== "package.json" || paths[1] !== "src/index.ts") return `read paths mismatch: ${paths}`;
      if (!String(runs[0].args.command || "").includes("find")) return "run command mismatch";
      if (runs[0].args.env?.CI !== "true" || runs[0].args.env?.SUITE !== "smoke") return "run env mismatch";
      return undefined;
    },
  },
];

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const message = payload?.error?.message || text || `HTTP ${response.status}`;
    throw new Error(`${path}: ${message}`);
  }
  return payload;
}

function parseChatSse(text) {
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    frames.push(JSON.parse(data));
  }
  return frames;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cooldownDelay() {
  try {
    const status = await jsonRequest("/api/admin/status", { headers: adminHeaders });
    const account = (status.accounts || []).find((item) => item.id === accountId);
    return Math.max(1_000, Number(account?.runtime?.cooldownUntil || 0) - Date.now() + 500);
  } catch {
    return 5_000;
  }
}

const failures = [];
const semanticFailures = [];
let httpSuccess = 0;
let sseToolSuccess = 0;
let semanticOk = 0;
let ownsAccount = false;
const runStartedAt = new Date(Date.now() - 10_000).toISOString();

try {
  const settingsBeforeProbe = await jsonRequest("/api/admin/settings", { headers: adminHeaders });
  previousRecordMessages = Boolean(settingsBeforeProbe?.settings?.recordMessages);
  const requestedAccountId = process.env.DEEPINFRA_PROBE_ACCOUNT_ID;
  if (requestedAccountId) {
    const existing = await jsonRequest("/api/admin/accounts", { headers: adminHeaders });
    if (!existing.accounts?.some((account) => account.id === requestedAccountId)) {
      throw new Error(`Probe account ${requestedAccountId} was not found.`);
    }
    accountId = requestedAccountId;
  } else {
    const created = await jsonRequest("/api/admin/accounts", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ email, password, label: `${total}-turn complex format probe`, weight: 1 }),
    });
    accountId = created.account.id;
    ownsAccount = true;
  }
  await jsonRequest("/api/admin/settings", {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ recordMessages: true }),
  });

  for (let index = 0; index < total; index += 1) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    const variant = variants[index % variants.length];
    const prompt = `${variant.prompt} Probe turn ${index + 1}. Return the function call, not prose.`;
    const requestBody = JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      tools: variant.tools,
      tool_choice: variant.toolChoice,
      parallel_tool_calls: variant.parallel,
      temperature,
      max_completion_tokens: 2_048,
      stream: true,
      stream_options: { include_usage: true },
      user: `${runId}-${index}`,
    });
    let response;
    let body = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: clientHeaders,
        body: requestBody,
      });
      body = await response.text();
      const retryable = response.status === 429
        || (response.status === 503 && body.includes("no_account_available"));
      if (!retryable || attempt === 3) break;
      const waitMs = await cooldownDelay();
      console.log(`rate-limit turn=${index + 1} retry=${attempt + 1} waitMs=${waitMs}`);
      await sleep(waitMs);
    }
    if (!response?.ok) {
      failures.push(`turn ${index}: HTTP ${response?.status}: ${body.slice(0, 500)}`);
      continue;
    }
    httpSuccess += 1;
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      failures.push(`turn ${index}: response was not SSE`);
      continue;
    }
    try {
      const frames = parseChatSse(body);
      const callsByIndex = new Map();
      for (const frame of frames) {
        for (const delta of frame.choices?.[0]?.delta?.tool_calls || []) {
          const slot = delta.index ?? 0;
          const entry = callsByIndex.get(slot) || { name: "", arguments: "" };
          if (delta.function?.name) entry.name += delta.function.name;
          if (delta.function?.arguments) entry.arguments += delta.function.arguments;
          callsByIndex.set(slot, entry);
        }
      }
      const calls = [...callsByIndex.values()].map((entry) => ({
        name: entry.name,
        args: JSON.parse(entry.arguments || "{}"),
      }));
      const finish = frames.some((frame) => frame.choices?.[0]?.finish_reason === "tool_calls");
      if (calls.length === 0 || !finish) {
        throw new Error("no tool calls or finish_reason mismatch");
      }
      sseToolSuccess += 1;
      const semanticError = variant.expect(calls);
      if (semanticError) {
        semanticFailures.push(`turn ${index} (${variant.name}): ${semanticError}`);
      } else {
        semanticOk += 1;
      }
    } catch (error) {
      failures.push(`turn ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((index + 1) % 5 === 0) {
      console.log(`progress=${index + 1}/${total} http=${httpSuccess} sseTools=${sseToolSuccess} semantic=${semanticOk}`);
    }
  }

  // The list endpoint returns summaries only; fetch full bodies per record.
  const summaries = (await jsonRequest("/api/admin/records?limit=500", { headers: adminHeaders })).records || [];
  const mine = summaries.filter((record) => record.model === model && record.at >= runStartedAt);
  const full = await Promise.all(mine.map((summary) =>
    jsonRequest(`/api/admin/records/${summary.id}`, { headers: adminHeaders })
      .then((payload) => payload.record)
      .catch(() => undefined)));
  const recordRunKey = (record) => {
    try {
      const parsed = JSON.parse(record.clientRequest?.body || "{}");
      return typeof parsed.user === "string" ? parsed.user : undefined;
    } catch {
      return undefined;
    }
  };
  const records = full
    .filter((record) => record && recordRunKey(record)?.startsWith(runId))
    .sort((a, b) => (recordRunKey(a) < recordRunKey(b) ? -1 : 1));
  const traced = records.filter((record) => {
    const trace = record.toolCallAdapter;
    return trace && (trace.initialOutcome === "invalid"
      || trace.finalOutcome === "tool_calls"
      || trace.finalOutcome === "invalid");
  });
  const initialSuccess = traced.filter((record) => record.toolCallAdapter.initialOutcome === "tool_calls").length;
  const initialRepairedSuccess = traced.filter((record) =>
    record.toolCallAdapter.initialOutcome === "tool_calls" && record.toolCallAdapter.initialParseRepaired).length;
  const initialRawSuccess = initialSuccess - initialRepairedSuccess;
  const repairedSuccess = traced.filter((record) =>
    !record.toolCallAdapter.initialParseSucceeded && record.toolCallAdapter.finalParseSucceeded).length;
  const finalParseFailure = traced.filter((record) => !record.toolCallAdapter.finalParseSucceeded).length;
  const firstPassRatePercent = traced.length === 0 ? 0 : Number((100 * initialSuccess / traced.length).toFixed(2));
  const rawFirstPassRatePercent = traced.length === 0 ? 0 : Number((100 * initialRawSuccess / traced.length).toFixed(2));
  const repairEligible = traced.filter((record) => record.toolCallAdapter.initialOutcome === "invalid").length;
  const repairSuccessRatePercent = repairEligible === 0
    ? null
    : Number((100 * repairedSuccess / repairEligible).toFixed(2));
  const errorSamples = traced.flatMap((record) => record.toolCallAdapter.errors || []).slice(0, 10);
  // Per-scenario breakdown: turn index maps back to the variant list.
  const variantStats = {};
  for (const record of traced) {
    const key = recordRunKey(record) || "";
    const turnIndex = Number.parseInt(key.slice(runId.length + 1), 10);
    const variantName = Number.isInteger(turnIndex) ? variants[turnIndex % variants.length].name : "unknown";
    const stats = variantStats[variantName] || (variantStats[variantName] = { turns: 0, initialSuccess: 0, rawSuccess: 0 });
    stats.turns += 1;
    if (record.toolCallAdapter.initialOutcome === "tool_calls") {
      stats.initialSuccess += 1;
      if (!record.toolCallAdapter.initialParseRepaired) stats.rawSuccess += 1;
    }
  }
  const passed = httpSuccess === total
    && sseToolSuccess === total
    && traced.length === total
    && (!requireFirstPassThreshold || firstPassRatePercent > 90)
    && finalParseFailure === 0
    && failures.length === 0;
  const summary = {
    runId,
    model,
    temperature,
    totalRequests: total,
    httpSuccess,
    sseToolSuccess,
    semanticOk,
    semanticFailed: semanticFailures.length,
    debugRecords: records.length,
    tracedToolTurns: traced.length,
    initialSuccess,
    initialRawSuccess,
    initialRepairedSuccess,
    repairedSuccess,
    repairEligible,
    repairSuccessRatePercent,
    finalParseFailure,
    firstPassRatePercent,
    rawFirstPassRatePercent,
    variantStats,
    errorSamples,
    semanticFailures: semanticFailures.slice(0, 10),
    failures,
    passed,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (accountId && ownsAccount) {
    await fetch(`${baseUrl}/api/admin/records?account_id=${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      headers: adminHeaders,
    }).catch(() => undefined);
    await fetch(`${baseUrl}/api/admin/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      headers: adminHeaders,
    }).catch(() => undefined);
  }
  if (previousRecordMessages !== undefined) {
    await fetch(`${baseUrl}/api/admin/settings`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ recordMessages: previousRecordMessages }),
    }).catch(() => undefined);
  }
}