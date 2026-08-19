import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const baseUrl = process.env.NEURALWATT_PROBE_BASE_URL || "http://localhost:3000";
const adminToken = process.env.NEURALWATT_PROBE_ADMIN_TOKEN;
const clientKey = process.env.NEURALWATT_PROBE_CLIENT_KEY;
const email = process.env.NEURALWATT_PROBE_EMAIL;
const password = process.env.NEURALWATT_PROBE_PASSWORD;
const runsPerCli = Number.parseInt(process.env.NEURALWATT_CLI_PROBE_RUNS || "1", 10);
const taskDelayMs = Number.parseInt(process.env.NEURALWATT_CLI_PROBE_DELAY_MS || "30000", 10);

for (const [name, value] of Object.entries({ adminToken, clientKey, email, password })) {
  if (!value) throw new Error(`Missing required probe setting: ${name}`);
}
if (!Number.isInteger(runsPerCli) || runsPerCli < 1 || runsPerCli > 10) {
  throw new Error("NEURALWATT_CLI_PROBE_RUNS must be an integer from 1 to 10.");
}
if (!Number.isInteger(taskDelayMs) || taskDelayMs < 0 || taskDelayMs > 120_000) {
  throw new Error("NEURALWATT_CLI_PROBE_DELAY_MS must be an integer from 0 to 120000.");
}

const adminHeaders = { "content-type": "application/json", "x-admin-token": adminToken };
const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is required to locate the installed CLIs.");
const codexEntrypoint = join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const openCodeEntrypoint = join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
const scratch = await mkdtemp(join(tmpdir(), "neuralwatt-cli-agent-probe-"));
const codexHome = join(scratch, "codex-home");
let accountId;
let previousRecordMessages;
let cliGatewayProxy;
const startedAt = new Date().toISOString();

const MAX_PROXY_REQUEST_BYTES = 16 * 1024 * 1024;

function safeResponseHeaders(headers) {
  const allowed = new Set(["content-type", "cache-control", "x-accel-buffering"]);
  return Object.fromEntries([...headers.entries()].filter(([name]) => allowed.has(name.toLowerCase())));
}

async function readProxyRequest(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_PROXY_REQUEST_BYTES) {
      throw new Error("CLI proxy request exceeded its size limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function startCliGatewayProxy() {
  const token = `probe_${randomUUID().replaceAll("-", "")}`;
  const postRequests = [];
  const server = createServer(async (incoming, outgoing) => {
    let trace;
    let traceRecorded = false;
    try {
      const incomingUrl = new URL(incoming.url || "/", "http://127.0.0.1");
      const method = incoming.method || "GET";
      const isModelRoute = incomingUrl.pathname === "/v1/models" || incomingUrl.pathname.startsWith("/v1/models/");
      const isCompletionRoute = incomingUrl.pathname === "/v1/chat/completions" || incomingUrl.pathname === "/v1/responses";
      if (incoming.headers.authorization !== `Bearer ${token}` || !((method === "GET" && isModelRoute) || (method === "POST" && isCompletionRoute))) {
        outgoing.writeHead(403, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { message: "Probe gateway route denied." } }));
        return;
      }
      const body = await readProxyRequest(incoming);
      if (method === "POST") {
        let stream = false;
        try {
          const parsed = JSON.parse(body.toString("utf8"));
          stream = parsed?.stream === true;
        } catch {
          // The gateway will record the malformed request too. Keep this trace
          // independent of debug storage so a dropped record fails the probe.
        }
        trace = { endpoint: incomingUrl.pathname, stream, status: 502 };
      }
      const response = await fetch(`${baseUrl}${incomingUrl.pathname}${incomingUrl.search}`, {
        method,
        headers: {
          Authorization: `Bearer ${clientKey}`,
          Accept: incoming.headers.accept || "application/json",
          ...(body.length > 0 ? { "Content-Type": incoming.headers["content-type"] || "application/json" } : {}),
        },
        ...(body.length > 0 ? { body } : {}),
      });
      if (trace) {
        trace.status = response.status;
        postRequests.push(trace);
        traceRecorded = true;
      }
      outgoing.writeHead(response.status, safeResponseHeaders(response.headers));
      if (!response.body) {
        outgoing.end();
        return;
      }
      Readable.fromWeb(response.body).on("error", () => outgoing.destroy()).pipe(outgoing);
    } catch {
      if (trace && !traceRecorded) postRequests.push(trace);
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { "content-type": "application/json" });
      }
      outgoing.end(JSON.stringify({ error: { message: "Probe gateway forwarding failed." } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Probe gateway did not receive a loopback port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    postRequests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function safeChildEnvironment(home, extra = {}) {
  const localAppData = join(home, "AppData", "Local");
  const roamingAppData = join(home, "AppData", "Roaming");
  const temp = join(home, "Temp");
  await Promise.all([home, localAppData, roamingAppData, temp].map((path) => mkdir(path, { recursive: true })));
  return {
    ComSpec: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
    SystemDrive: process.env.SystemDrive || "C:",
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    WINDIR: process.env.WINDIR || process.env.SystemRoot || "C:\\Windows",
    PATH: process.env.PATH || process.env.Path || "",
    PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE || "AMD64",
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS || "1",
    OS: process.env.OS || "Windows_NT",
    HOME: home,
    USERPROFILE: home,
    APPDATA: roamingAppData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    ...extra,
  };
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : undefined; } catch { payload = undefined; }
  if (!response.ok) {
    throw new Error(payload?.error?.message || text || `${path}: HTTP ${response.status}`);
  }
  return payload;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, options.timeoutMs || 300_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function seedProject(workspace, seed) {
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: `agent-order-${seed}`,
    private: true,
    type: "module",
    scripts: { test: "node test/run.mjs" },
  }, null, 2));
  await writeFile(join(workspace, "src", "order.js"), [
    "export function summarizeOrder(items, taxRate) {",
    "  throw new Error('TODO summarizeOrder');",
    "}",
    "",
    "export function formatReceipt(summary) {",
    "  throw new Error('TODO formatReceipt');",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(workspace, "src", "inventory.js"), [
    "export function lowStock(items, threshold) {",
    "  throw new Error('TODO lowStock');",
    "}",
    "",
    "export function restockPlan(items, target) {",
    "  throw new Error('TODO restockPlan');",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(workspace, "test", "run.mjs"), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { summarizeOrder, formatReceipt } from '../src/order.js';",
    "import { lowStock, restockPlan } from '../src/inventory.js';",
    "",
    "const items = [",
    `  { sku: 'A-${seed}', quantity: 2, unitPrice: 7.5, stock: 3 },`,
    `  { sku: 'B-${seed}', quantity: 3, unitPrice: 4, stock: 8 },`,
    `  { sku: 'C-${seed}', quantity: 1, unitPrice: 10, stock: 1 },`,
    "];",
    "const summary = summarizeOrder(items, 0.08);",
    "assert.deepEqual(summary, { itemCount: 6, subtotal: 37, tax: 2.96, total: 39.96 });",
    "assert.equal(formatReceipt(summary), 'Items: 6\\nSubtotal: 37.00\\nTax: 2.96\\nTotal: 39.96');",
    `assert.deepEqual(lowStock(items, 4), ['A-${seed}', 'C-${seed}']);`,
    `assert.deepEqual(restockPlan(items, 10), [{ sku: 'A-${seed}', quantity: 7 }, { sku: 'B-${seed}', quantity: 2 }, { sku: 'C-${seed}', quantity: 9 }]);`,
    "assert.doesNotMatch(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /## Implementation\\s+TODO/);",
    `assert.deepEqual(JSON.parse(readFileSync(new URL('../agent-result.json', import.meta.url), 'utf8')), { status: 'passed', seed: ${seed}, modules: 2 });`,
    "console.log('VISIBLE_TESTS_OK');",
    "",
  ].join("\n"));
  await writeFile(join(workspace, "README.md"), [
    `# Agent order project ${seed}`,
    "",
    "## Implementation",
    "",
    "TODO",
    "",
  ].join("\n"));
}

function taskPrompt(seed) {
  return [
    "Work autonomously in this isolated JavaScript project.",
    "Inspect package.json, both src modules, the visible test, and README.md.",
    "Implement every TODO in src/order.js and src/inventory.js without changing test/run.mjs.",
    "Requirements: monetary values round to two decimals; receipt uses exactly four lines; lowStock sorts SKUs; restockPlan keeps input order and emits only positive needs.",
    "For OpenCode use native read/write/edit tools for file work; do not use the bash tool for discovery or file edits, and do not use shell heredocs or patch syntax. Use bash only to run npm test, with commands valid for the operating system described by the tool. For Codex this is a Windows workspace: use PowerShell file commands or node commands only for paths beneath the current workspace. Do not use apply_patch, heredocs, encoded scripts, or any path outside the workspace.",
    "Update the README Implementation section with a concise description.",
    `After all source and README edits, create agent-result.json with exactly {\"status\":\"passed\",\"seed\":${seed},\"modules\":2}.`,
    "Only then run npm test. Diagnose any failure and fix the implementation until it passes, then read agent-result.json and run npm test one final time.",
    `When everything is verified, finish with exactly AGENT_PROJECT_OK seed=${seed}.`,
  ].join("\n");
}

async function hiddenVerify(workspace, seed) {
  const hiddenPath = join(workspace, "hidden-check.mjs");
  await writeFile(hiddenPath, [
    "import assert from 'node:assert/strict';",
    "import { summarizeOrder, formatReceipt } from './src/order.js';",
    "import { lowStock, restockPlan } from './src/inventory.js';",
    "const items = [",
    "  { sku: 'Z', quantity: 1, unitPrice: 0.1, stock: 12 },",
    "  { sku: 'X', quantity: 4, unitPrice: 2.25, stock: 0 },",
    "  { sku: 'Y', quantity: 2, unitPrice: 1.05, stock: 2 },",
    "];",
    "const summary = summarizeOrder(items, 0.075);",
    "assert.deepEqual(summary, { itemCount: 7, subtotal: 11.2, tax: 0.84, total: 12.04 });",
    "assert.equal(formatReceipt(summary), 'Items: 7\\nSubtotal: 11.20\\nTax: 0.84\\nTotal: 12.04');",
    "assert.deepEqual(lowStock(items, 3), ['X', 'Y']);",
    "assert.deepEqual(restockPlan(items, 5), [{ sku: 'X', quantity: 5 }, { sku: 'Y', quantity: 3 }]);",
    "console.log('HIDDEN_TESTS_OK');",
  ].join("\n"));
  // These are model-authored project files. Run them without the parent
  // probe's credentials even though their checks are otherwise local.
  const verifierEnvironment = await safeChildEnvironment(join(scratch, "verifier-user"));
  const visible = await runProcess(process.execPath, [join(workspace, "test", "run.mjs")], {
    cwd: workspace,
    env: verifierEnvironment,
    timeoutMs: 30_000,
  });
  const hidden = await runProcess(process.execPath, [hiddenPath], {
    cwd: workspace,
    env: verifierEnvironment,
    timeoutMs: 30_000,
  });
  let result;
  try { result = JSON.parse(await readFile(join(workspace, "agent-result.json"), "utf8")); } catch { result = undefined; }
  const sources = `${await readFile(join(workspace, "src", "order.js"), "utf8")}\n${await readFile(join(workspace, "src", "inventory.js"), "utf8")}`;
  const readme = await readFile(join(workspace, "README.md"), "utf8");
  return {
    visibleExit: visible.code,
    hiddenExit: hidden.code,
    resultOk: result?.status === "passed" && result?.seed === seed && result?.modules === 2,
    todosRemoved: !sources.includes("TODO"),
    readmeUpdated: !/## Implementation\s+TODO/.test(readme),
  };
}

function parseJsonLines(output) {
  const events = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

async function runCodex(workspace, seed, gateway) {
  await mkdir(codexHome, { recursive: true });
  // Keep the child isolated from the user's Codex configuration while retaining
  // the Windows sandbox mode required for workspace-write command execution.
  await writeFile(join(codexHome, "config.toml"), [
    'approval_policy = "never"',
    "",
    "[windows]",
    'sandbox = "elevated"',
    "",
  ].join("\n"), "utf8");
  const env = await safeChildEnvironment(join(scratch, "codex-user"), {
    CODEX_HOME: codexHome,
    NEURALWATT_CLI_TEST_KEY: gateway.token,
  });
  const args = [
    codexEntrypoint,
    "--ask-for-approval", "never",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "--disable", "remote_plugin",
    "-C", workspace,
    "-m", "kimi-k3-fast",
    "-c", 'model_provider="neuralwatt"',
    "-c", 'model_providers.neuralwatt.name="NeuralWatt local gateway"',
    "-c", `model_providers.neuralwatt.base_url="${gateway.baseUrl}/v1"`,
    "-c", 'model_providers.neuralwatt.env_key="NEURALWATT_CLI_TEST_KEY"',
    "-c", 'model_providers.neuralwatt.wire_api="responses"',
    "-c", "model_providers.neuralwatt.requires_openai_auth=false",
    taskPrompt(seed),
  ];
  const processResult = await runProcess(process.execPath, args, { cwd: workspace, env });
  const events = parseJsonLines(processResult.stdout);
  const errors = events.filter((event) => event.type === "error" || event.type === "turn.failed");
  const tools = events.filter((event) => {
    const item = event.item || {};
    return event.type === "item.completed" && ["command_execution", "mcp_tool_call"].includes(item.type);
  });
  return { processResult, eventCount: events.length, toolEvents: tools.length, errorEvents: errors.length };
}

async function runOpenCode(workspace, seed, gateway) {
  // The outer Codex `sandbox` command restricts the whole OpenCode process,
  // including its bash tool, to this disposable workspace. Keep every OpenCode
  // runtime directory inside that writable root so the sandbox does not need
  // access to the real user profile or a second writable directory.
  const runtimeRoot = join(workspace, ".opencode-probe-runtime");
  const xdg = {
    XDG_CONFIG_HOME: join(runtimeRoot, "config"),
    XDG_DATA_HOME: join(runtimeRoot, "data"),
    XDG_CACHE_HOME: join(runtimeRoot, "cache"),
    XDG_STATE_HOME: join(runtimeRoot, "state"),
  };
  const sandboxCodexHome = join(runtimeRoot, "codex-home");
  const childHome = join(runtimeRoot, "home");
  await Promise.all([
    ...Object.values(xdg),
    sandboxCodexHome,
  ].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(sandboxCodexHome, "config.toml"), [
    "[permissions.opencode_probe]",
    'extends = ":workspace"',
    "",
    "[permissions.opencode_probe.network]",
    "enabled = true",
    'mode = "limited"',
    "",
    "[permissions.opencode_probe.network.domains]",
    '"127.0.0.1" = "allow"',
    '"localhost" = "allow"',
    "",
    "[windows]",
    'sandbox = "elevated"',
    "",
  ].join("\n"), "utf8");
  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: {
      read: "allow", edit: "allow", glob: "allow", grep: "allow", bash: "allow",
      external_directory: "deny", webfetch: "deny", websearch: "deny", task: "deny",
    },
    provider: {
      neuralwatt: {
        npm: "@ai-sdk/openai-compatible",
        name: "NeuralWatt local gateway",
        options: { baseURL: `${gateway.baseUrl}/v1`, apiKey: "{env:NEURALWATT_CLI_TEST_KEY}" },
        models: { "kimi-k3-fast": { name: "Kimi K3 Fast", limit: { context: 131_072, output: 8_192 } } },
      },
    },
  };
  const env = await safeChildEnvironment(childHome, {
    ...xdg,
    CODEX_HOME: sandboxCodexHome,
    NEURALWATT_CLI_TEST_KEY: gateway.token,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  });
  const args = [
    codexEntrypoint,
    "sandbox",
    "--permission-profile", "opencode_probe",
    "-C", workspace,
    openCodeEntrypoint,
    "run", "--pure", "--format", "json",
    "--dir", workspace,
    "--model", "neuralwatt/kimi-k3-fast",
    taskPrompt(seed),
  ];
  const processResult = await runProcess(process.execPath, args, { cwd: workspace, env });
  const events = parseJsonLines(processResult.stdout);
  const tools = events.filter((event) => event.type === "tool_use" || event.part?.type === "tool");
  const errors = events.filter((event) =>
    /error|failed/.test(event.type || "") || /error|failed/.test(event.part?.state?.status || ""));
  const failedTools = tools.filter((event) =>
    event.part?.state?.status !== "completed"
      || (event.part?.state?.metadata?.exit != null && event.part.state.metadata.exit !== 0));
  return {
    processResult,
    eventCount: events.length,
    toolEvents: tools.length,
    errorEvents: errors.length,
    failedTools: failedTools.length,
    failedToolDetails: failedTools.slice(0, 3).map((event) => ({
      tool: event.part?.tool,
      status: event.part?.state?.status,
      exit: event.part?.state?.metadata?.exit,
      error: event.part?.state?.error,
    })),
  };
}

const taskResults = [];
try {
  cliGatewayProxy = await startCliGatewayProxy();
  const settingsBeforeProbe = await jsonRequest("/api/admin/settings", { headers: adminHeaders });
  previousRecordMessages = Boolean(settingsBeforeProbe?.settings?.recordMessages);
  const created = await jsonRequest("/api/admin/accounts", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password, label: "Codex and OpenCode project probe", weight: 1 }),
  });
  accountId = created.account.id;
  await jsonRequest("/api/admin/settings", {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ recordMessages: true }),
  });

  const clients = [
    { name: "codex", run: runCodex, seedBase: 100 },
    { name: "opencode", run: runOpenCode, seedBase: 200 },
  ];
  let taskIndex = 0;
  for (const client of clients) {
    for (let run = 0; run < runsPerCli; run += 1) {
      if (taskIndex > 0 && taskDelayMs > 0) await sleep(taskDelayMs);
      const seed = client.seedBase + run;
      const workspace = join(scratch, `${client.name}-${seed}`);
      await seedProject(workspace, seed);
      const cli = await client.run(workspace, seed, cliGatewayProxy);
      const verification = await hiddenVerify(workspace, seed).catch((error) => ({ error: error.message }));
      const passed = cli.processResult.code === 0
        && cli.errorEvents === 0
        && (cli.failedTools || 0) === 0
        && verification.visibleExit === 0
        && verification.hiddenExit === 0
        && verification.resultOk
        && verification.todosRemoved
        && verification.readmeUpdated;
      taskResults.push({
        client: client.name,
        seed,
        cliExit: cli.processResult.code,
        eventCount: cli.eventCount,
        toolEvents: cli.toolEvents,
        errorEvents: cli.errorEvents,
        failedTools: cli.failedTools || 0,
        failedToolDetails: cli.failedToolDetails,
        verification,
        stderrTail: cli.processResult.stderr.split(/\r?\n/).filter(Boolean).slice(-3),
        passed,
      });
      console.log(`task=${client.name}-${seed} passed=${passed} toolEvents=${cli.toolEvents}`);
      taskIndex += 1;
    }
  }

  const debug = await jsonRequest("/api/admin/records?limit=500", { headers: adminHeaders });
  const records = (debug.records || []).filter((record) =>
    record.accountId === accountId && record.at >= startedAt);
  const adapterRecords = records.filter((record) => record.toolCallAdapter);
  // Count every turn that attempted a controlled tool envelope. A final
  // invalid outcome must remain in the denominator instead of disappearing
  // from the accuracy metric.
  const toolIntents = adapterRecords.filter((record) => {
    const trace = record.toolCallAdapter;
    return trace.initialOutcome === "invalid"
      || trace.finalOutcome === "tool_calls"
      || trace.finalOutcome === "invalid";
  });
  const initialToolSuccess = toolIntents.filter((record) => record.toolCallAdapter.initialOutcome === "tool_calls").length;
  const initialAccuracyPercent = toolIntents.length === 0
    ? 0
    : Number((100 * initialToolSuccess / toolIntents.length).toFixed(2));
  const repairEligible = adapterRecords.filter((record) => record.toolCallAdapter.initialOutcome === "invalid");
  const repairSuccess = repairEligible.filter((record) => record.toolCallAdapter.finalParseSucceeded).length;
  const repairSuccessPercent = repairEligible.length === 0
    ? null
    : Number((100 * repairSuccess / repairEligible.length).toFixed(2));
  const streamRequests = records.filter((record) => record.clientRequest?.stream === true).length;
  const proxiedStreamRequests = cliGatewayProxy.postRequests.filter((request) => request.stream).length;
  const byEndpoint = Object.entries(Object.groupBy(records, (record) => record.endpoint))
    .map(([endpoint, items]) => ({ endpoint, turns: items.length }));
  const repairDiagnostics = repairEligible.map((record) => ({
    endpoint: record.endpoint,
    initialOutcome: record.toolCallAdapter?.initialOutcome,
    finalOutcome: record.toolCallAdapter?.finalOutcome,
    repairAttempts: record.toolCallAdapter?.repairAttempts,
    errors: record.toolCallAdapter?.errors,
  }));
  const summary = {
    tasks: taskResults,
    gateway: {
      tracedTurns: records.length,
      proxiedTurns: cliGatewayProxy.postRequests.length,
      toolIntents: toolIntents.length,
      initialToolSuccess,
      initialAccuracyPercent,
      repairEligible: repairEligible.length,
      repairSuccess,
      repairSuccessPercent,
      streamRequests,
      proxiedStreamRequests,
      byEndpoint,
      repairDiagnostics,
    },
    tasksPassed: taskResults.every((task) => task.passed),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (records.length !== cliGatewayProxy.postRequests.length) {
    console.error("Probe debug records do not match the independent loopback request trace; refusing a truncated denominator.");
    process.exitCode = 1;
  }
  if (!summary.tasksPassed
    || toolIntents.length === 0
    || initialAccuracyPercent <= 90
    || streamRequests !== records.length
    || proxiedStreamRequests !== cliGatewayProxy.postRequests.length
    || (repairSuccessPercent !== null && repairSuccessPercent < 99)) {
    process.exitCode = 1;
  }
} finally {
  if (accountId) {
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
  if (cliGatewayProxy) {
    await cliGatewayProxy.close().catch(() => undefined);
  }
  const expectedPrefix = `${tmpdir()}${sep}neuralwatt-cli-agent-probe-`;
  if (scratch.startsWith(expectedPrefix) && relative(tmpdir(), scratch) && dirname(scratch) === tmpdir()) {
    await rm(scratch, { recursive: true, force: true });
  }
}
