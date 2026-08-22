import fs from "node:fs";

const dir = ".data/neuralwatt/records";
const runId = process.argv[2];
if (!runId) throw new Error("usage: node scripts/analyze-run.mjs <runId>");

const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
const rows = [];
for (const name of files) {
  const record = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8"));
  let user;
  try {
    user = JSON.parse(record.clientRequest?.body || "{}").user;
  } catch {
    continue;
  }
  if (typeof user !== "string" || !user.startsWith(runId)) continue;
  const trace = record.toolCallAdapter || {};
  rows.push({
    user: user.slice(runId.length + 1),
    initial: trace.initialOutcome,
    final: trace.finalOutcome,
    repairs: trace.repairAttempts ?? 0,
    initialRepaired: trace.initialParseRepaired === true,
    errors: trace.errors || [],
    upstreamCalls: (record.upstreamCalls || []).length,
  });
}
rows.sort((a, b) => a.user.localeCompare(b.user));

let firstPass = 0;
let firstPassRaw = 0;
let repaired = 0;
let failed = 0;
for (const row of rows) {
  if (row.initial === "tool_calls") {
    firstPass += 1;
    if (!row.initialRepaired) firstPassRaw += 1;
  } else if (row.final === "tool_calls") {
    repaired += 1;
  } else {
    failed += 1;
  }
  const marker = row.initial === "tool_calls" ? (row.initialRepaired ? "FIRST-PASS(repaired)" : "FIRST-PASS(raw)") : row.final === "tool_calls" ? `REPAIRED(x${row.repairs})` : "FAILED";
  console.log(`${marker} ${row.user}${row.errors.length ? ` — ${row.errors.join("; ").slice(0, 220)}` : ""}`);
}
console.log(JSON.stringify({
  total: rows.length,
  firstPass,
  firstPassRaw,
  firstPassRepaired: firstPass - firstPassRaw,
  repairedAfterInvalid: repaired,
  failed,
  firstPassRate: rows.length ? Number((100 * firstPass / rows.length).toFixed(1)) : 0,
}, null, 2));
