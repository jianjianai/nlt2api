/**
 * Per-model JSON/XML tool-call format sensitivity driver.
 *
 * For every model × format combination this script:
 *   1. Pins the model's tool-call format via PATCH /api/admin/settings
 *      (modelToolCallFormats), leaving every other model's override intact.
 *   2. Runs scripts/probe-tool-first-pass.mjs against the existing account
 *      and captures the summary JSON it prints.
 *   3. Appends the outcome to a results file, so interrupted runs resume
 *      without repeating completed combinations.
 *
 * Usage:
 *   node scripts/probe-format-sensitivity.mjs \
 *     --account=<id> [--models=a,b] [--formats=json,xml] \
 *     [--turns=20] [--delay=3000] [--endpoint=chat] \
 *     [--results=.data/format-sensitivity-results.json] \
 *     [--logs=.data/format-sensitivity-logs]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function loadEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    values[match[1]] = match[2];
  }
  return values;
}

const envFile = loadEnvFile(resolve(".env"));
const baseUrl = process.env.DEEPINFRA_PROBE_BASE_URL || "http://localhost:3000";
const adminToken = process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN || envFile.DEEPINFRA_GATEWAY_ADMIN_TOKEN;
const clientKey = process.env.DEEPINFRA_GATEWAY_API_KEY || envFile.DEEPINFRA_GATEWAY_API_KEY;
const accountId = arg("account", process.env.DEEPINFRA_PROBE_ACCOUNT_ID || "");
const turns = Number.parseInt(arg("turns", "20"), 10);
const delayMs = Number.parseInt(arg("delay", "3000"), 10);
const endpoint = arg("endpoint", "chat");
const resultsPath = resolve(arg("results", ".data/format-sensitivity-results.json"));
const logsDir = resolve(arg("logs", ".data/format-sensitivity-logs"));
const probeScript = arg("script", "scripts/probe-tool-first-pass.mjs");
const formats = arg("formats", "json,xml").split(",").map((value) => value.trim()).filter(Boolean);

if (!adminToken || !clientKey) {
  throw new Error("Admin token and client API key are required (env or .env).");
}
if (!accountId) {
  throw new Error("--account=<id> is required so the probe reuses the existing account.");
}
if (!Number.isInteger(turns) || turns < 1 || turns > 100) {
  throw new Error("--turns must be an integer from 1 to 100.");
}

const adminHeaders = {
  "content-type": "application/json",
  "x-admin-token": adminToken,
};

async function adminJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...adminHeaders, ...(init.headers || {}) } });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return payload;
}

function loadResults() {
  if (!existsSync(resultsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(resultsPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveResults(results) {
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
}

/** Extract the pretty-printed summary object the probe prints last. */
function extractSummary(output) {
  const marker = output.lastIndexOf('\n{\n');
  const start = marker >= 0 ? marker + 1 : (output.startsWith("{\n") ? 0 : -1);
  if (start < 0) return undefined;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return undefined;
  }
}

async function pinFormat(model, format) {
  const current = await adminJson("/api/admin/settings");
  const map = { ...(current.settings?.modelToolCallFormats || {}) };
  map[model] = format;
  await adminJson("/api/admin/settings", {
    method: "PATCH",
    body: JSON.stringify({ modelToolCallFormats: map }),
  });
}

function runProbe(model, format) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [probeScript], {
      env: {
        ...process.env,
        DEEPINFRA_PROBE_BASE_URL: baseUrl,
        DEEPINFRA_PROBE_ADMIN_TOKEN: adminToken,
        DEEPINFRA_PROBE_CLIENT_KEY: clientKey,
        // Unused when an account id is supplied, but the probe requires them.
        DEEPINFRA_PROBE_EMAIL: "probe-reuse@example.invalid",
        DEEPINFRA_PROBE_PASSWORD: "probe-reuse-unused",
        DEEPINFRA_PROBE_ACCOUNT_ID: accountId,
        DEEPINFRA_PROBE_MODEL: model,
        DEEPINFRA_PROBE_TURNS: String(turns),
        DEEPINFRA_PROBE_DELAY_MS: String(delayMs),
        DEEPINFRA_PROBE_ENDPOINT: endpoint,
        // Data collection only: never fail the run on the pass threshold.
        DEEPINFRA_PROBE_REQUIRE_FIRST_PASS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      output += "\nDRIVER_TIMEOUT: probe exceeded 45 minutes\n";
    }, 45 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolveRun({ code, output });
    });
  });
}

const accounts = await adminJson("/api/admin/accounts");
const account = (accounts.accounts || []).find((item) => item.id === accountId);
if (!account) {
  throw new Error(`Account ${accountId} not found.`);
}
const availableModels = account.models || [];
const requested = arg("models", "").split(",").map((value) => value.trim()).filter(Boolean);
const models = requested.length > 0 ? requested : availableModels;
for (const model of models) {
  if (!availableModels.includes(model)) {
    throw new Error(`Model '${model}' is not served by account ${accountId}.`);
  }
}

mkdirSync(logsDir, { recursive: true });
const results = loadResults();
console.log(`driver: ${models.length} model(s) × ${formats.length} format(s), ${turns} turns, delay ${delayMs}ms`);
console.log(`driver: results -> ${resultsPath}`);

for (const model of models) {
  for (const format of formats) {
    const key = (entry) => entry.model === model && entry.format === format && entry.turns === turns && entry.script === probeScript;
    const done = results.find((entry) => key(entry) && entry.tracedToolTurns > 0 && entry.firstPassRatePercent !== undefined);
    if (done) {
      console.log(`skip ${model}/${format}: already measured (firstPass=${done.firstPassRatePercent})`);
      continue;
    }
    // Replace any incomplete earlier attempt for the same combination.
    const stale = results.findIndex((entry) => key(entry));
    if (stale >= 0) results.splice(stale, 1);
    console.log(`run ${model}/${format}: pinning format and probing...`);
    await pinFormat(model, format);
    const startedAt = new Date().toISOString();
    const { code, output } = await runProbe(model, format);
    const logFile = resolve(logsDir, `${model.replace(/[^A-Za-z0-9_.-]/g, "_")}-${format}.log`);
    writeFileSync(logFile, output);
    const summary = extractSummary(output);
    const entry = {
      model,
      format,
      script: probeScript,
      turns,
      delayMs,
      endpoint,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      logFile,
      ...(summary ? {
        httpSuccess: summary.httpSuccess,
        sseToolSuccess: summary.sseToolSuccess,
        tracedToolTurns: summary.tracedToolTurns,
        firstPassRatePercent: summary.firstPassRatePercent,
        rawFirstPassRatePercent: summary.rawFirstPassRatePercent,
        semanticOk: summary.semanticOk,
        semanticFailed: summary.semanticFailed,
        variantStats: summary.variantStats,
        repairSuccessRatePercent: summary.repairSuccessRatePercent,
        finalParseFailure: summary.finalParseFailure,
        failureCount: Array.isArray(summary.failures) ? summary.failures.length : undefined,
        errorSamples: summary.errorSamples,
      } : { parseError: "probe summary not found in output" }),
    };
    results.push(entry);
    saveResults(results);
    console.log(`done ${model}/${format}: firstPass=${entry.firstPassRatePercent ?? "n/a"} raw=${entry.rawFirstPassRatePercent ?? "n/a"} finalParseFailure=${entry.finalParseFailure ?? "n/a"}`);
  }
}

console.log("driver: all combinations complete");
