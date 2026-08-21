const baseUrl = process.env.NEURALWATT_PROBE_BASE_URL || "http://localhost:3000";
const adminToken = process.env.NEURALWATT_PROBE_ADMIN_TOKEN;
const clientKey = process.env.NEURALWATT_PROBE_CLIENT_KEY;
const email = process.env.NEURALWATT_PROBE_EMAIL;
const password = process.env.NEURALWATT_PROBE_PASSWORD;
const total = Number.parseInt(process.env.NEURALWATT_PROBE_TURNS || "40", 10);
const delayMs = Number.parseInt(process.env.NEURALWATT_PROBE_DELAY_MS || "3500", 10);
const model = process.env.NEURALWATT_PROBE_MODEL || "kimi-k3-fast";
const temperature = Number(process.env.NEURALWATT_PROBE_TEMPERATURE ?? "0");
const requireFirstPassThreshold = process.env.NEURALWATT_PROBE_REQUIRE_FIRST_PASS !== "false";
const minimumRepairEligible = Number.parseInt(process.env.NEURALWATT_PROBE_MIN_REPAIRS || "0", 10);
const endpoint = process.env.NEURALWATT_PROBE_ENDPOINT || "chat";
if (!["chat", "responses"].includes(endpoint)) {
  throw new Error("NEURALWATT_PROBE_ENDPOINT must be chat or responses.");
}

for (const [name, value] of Object.entries({ adminToken, clientKey, email, password })) {
  if (!value) {
    throw new Error(`Missing required probe setting: ${name}`);
  }
}
if (!Number.isInteger(total) || total < 1 || total > 100) {
  throw new Error("NEURALWATT_PROBE_TURNS must be an integer from 1 to 100.");
}
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
  throw new Error("NEURALWATT_PROBE_DELAY_MS must be an integer from 0 to 60000.");
}
if (typeof model !== "string" || !model.trim() || model.length > 200) {
  throw new Error("NEURALWATT_PROBE_MODEL must be a non-empty model name.");
}
if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
  throw new Error("NEURALWATT_PROBE_TEMPERATURE must be between 0 and 2.");
}
if (!Number.isInteger(minimumRepairEligible) || minimumRepairEligible < 0 || minimumRepairEligible > total) {
  throw new Error("NEURALWATT_PROBE_MIN_REPAIRS must be an integer from 0 through NEURALWATT_PROBE_TURNS.");
}

const adminHeaders = {
  "content-type": "application/json",
  "x-admin-token": adminToken,
};
const clientHeaders = {
  authorization: `Bearer ${clientKey}`,
  "content-type": "application/json",
};
const runId = `first-pass-${crypto.randomUUID().replaceAll("-", "")}`;
let accountId;
let previousRecordMessages;

const variants = [
  {
    name: "read_project_file",
    prompt: "Call read_project_file for package.json, lines 1 through 40, UTF-8, with metadata enabled.",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9_./-]+$" },
        range: {
          type: "object",
          properties: {
            start: { type: "integer", minimum: 1 },
            end: { type: "integer", minimum: 1 },
          },
          required: ["start", "end"],
          additionalProperties: false,
        },
        options: {
          type: "object",
          properties: {
            encoding: { type: "string", enum: ["utf8", "ascii"] },
            include_metadata: { type: "boolean" },
          },
          required: ["encoding", "include_metadata"],
          additionalProperties: false,
        },
      },
      required: ["path", "range", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_refactor",
    prompt: "Call plan_refactor for server/a.ts and server/b.ts. Rename oldName to newName, then update imports. Use high priority and dry_run true.",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        files: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string" } },
        operations: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["rename_symbol", "update_imports"] },
              from: { type: "string" },
              to: { type: "string" },
            },
            required: ["action", "from", "to"],
            additionalProperties: false,
          },
        },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        dry_run: { type: "boolean" },
      },
      required: ["files", "operations", "priority", "dry_run"],
      additionalProperties: false,
    },
  },
  {
    name: "calculate_batch",
    prompt: "Call calculate_batch with 17, 19, 23, product, expected 7429, request id probe, and tags arithmetic and verification.",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        values: { type: "array", minItems: 3, maxItems: 6, items: { type: "integer" } },
        operation: { type: "string", enum: ["sum", "product"] },
        expected: { type: "integer" },
        metadata: {
          type: "object",
          properties: {
            request_id: { type: "string", minLength: 1 },
            tags: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string" } },
          },
          required: ["request_id", "tags"],
          additionalProperties: false,
        },
      },
      required: ["values", "operation", "expected", "metadata"],
      additionalProperties: false,
    },
  },
  {
    name: "search_workspace",
    prompt: "Call search_workspace for executeChatRequest in TypeScript only, excluding node_modules and dist, maximum 25, case-sensitive false.",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: { type: "string", minLength: 3 },
        filters: {
          type: "object",
          properties: {
            extensions: {
              type: "array",
              minItems: 1,
              items: { type: "string", enum: ["ts", "tsx", "vue"] },
            },
            exclude: { type: "array", minItems: 2, items: { type: "string" } },
            case_sensitive: { type: "boolean" },
          },
          required: ["extensions", "exclude", "case_sensitive"],
          additionalProperties: false,
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query", "filters", "limit"],
      additionalProperties: false,
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
let httpSuccess = 0;
let sseToolSuccess = 0;
let ownsAccount = false;

try {
  const settingsBeforeProbe = await jsonRequest("/api/admin/settings", { headers: adminHeaders });
  previousRecordMessages = Boolean(settingsBeforeProbe?.settings?.recordMessages);
  const requestedAccountId = process.env.NEURALWATT_PROBE_ACCOUNT_ID;
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
      body: JSON.stringify({
        email,
        password,
        label: `${total}-turn first-pass tool JSON probe`,
        weight: 1,
      }),
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
    const requestBody = endpoint === "responses"
      ? JSON.stringify({
        model,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
        tools: [{
          type: "function",
          name: variant.name,
          description: "A deterministic local agent test function.",
          parameters: variant.schema,
          strict: true,
        }],
        tool_choice: { type: "function", name: variant.name },
        parallel_tool_calls: false,
        temperature,
        max_output_tokens: 1_024,
        stream: true,
        store: false,
        prompt_cache_key: `${runId}-${index}`,
      })
      : JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: prompt,
        }],
        tools: [{
          type: "function",
          function: {
            name: variant.name,
            description: "A deterministic local agent test function.",
            parameters: variant.schema,
            strict: true,
          },
        }],
        tool_choice: { type: "function", function: { name: variant.name } },
        parallel_tool_calls: false,
        temperature,
        max_completion_tokens: 1_024,
        stream: true,
        stream_options: { include_usage: true },
        user: `${runId}-${index}`,
      });
    let response;
    let body = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(`${baseUrl}${endpoint === "responses" ? "/v1/responses" : "/v1/chat/completions"}`, {
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
      let toolName;
      let rawArguments;
      let finish;
      if (endpoint === "responses") {
        const argsDone = frames.find((frame) => frame.type === "response.function_call_arguments.done");
        const itemDone = frames.find((frame) =>
          frame.type === "response.output_item.done" && frame.item?.type === "function_call");
        const completed = frames.find((frame) => frame.type === "response.completed");
        toolName = itemDone?.item?.name;
        rawArguments = argsDone?.arguments ?? itemDone?.item?.arguments ?? "";
        finish = completed?.response?.status === "completed";
      } else {
        const toolCall = frames
          .flatMap((frame) => frame.choices?.[0]?.delta?.tool_calls || [])
          .find(Boolean);
        toolName = toolCall?.function?.name;
        rawArguments = toolCall?.function?.arguments || "";
        finish = frames.some((frame) => frame.choices?.[0]?.finish_reason === "tool_calls");
      }
      const parsedArguments = JSON.parse(rawArguments);
      if (toolName !== variant.name || !finish || !parsedArguments) {
        throw new Error("tool name, arguments, or finish_reason mismatch");
      }
      sseToolSuccess += 1;
    } catch (error) {
      failures.push(`turn ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((index + 1) % 5 === 0) {
      console.log(`progress=${index + 1}/${total} http=${httpSuccess} sseTools=${sseToolSuccess}`);
    }
  }

  const debug = await jsonRequest("/api/admin/records?limit=500", { headers: adminHeaders });
  const recordRunKey = (record) => {
    try {
      const parsed = JSON.parse(record.clientRequest?.body || "{}");
      return typeof parsed.user === "string" ? parsed.user : typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key : undefined;
    } catch {
      return undefined;
    }
  };
  const records = (debug.records || []).filter((record) => recordRunKey(record)?.startsWith(runId));
  const traced = records.filter((record) => {
    const trace = record.toolCallAdapter;
    return trace && (trace.initialOutcome === "invalid"
      || trace.finalOutcome === "tool_calls"
      || trace.finalOutcome === "invalid");
  });
  const initialSuccess = traced.filter((record) => record.toolCallAdapter.initialOutcome === "tool_calls").length;
  // Split the first pass into clean parses and parses jsonrepair had to fix,
  // so a degraded raw rate is not hidden behind the repair fallback.
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
  const repairHistogram = Object.entries(Object.groupBy(
    traced,
    (record) => String(record.toolCallAdapter.repairAttempts),
  )).map(([attempts, items]) => ({ attempts: Number(attempts), count: items.length }));
  const errorSamples = traced.flatMap((record) => record.toolCallAdapter.errors || []).slice(0, 10);
  const passed = httpSuccess === total
    && sseToolSuccess === total
    && traced.length === total
    && (!requireFirstPassThreshold || firstPassRatePercent > 90)
    && finalParseFailure === 0
    && repairEligible >= minimumRepairEligible
    && (repairSuccessRatePercent === null || repairSuccessRatePercent >= 99)
    && failures.length === 0;
  if (records.length >= 500) {
    console.error("Probe debug record capacity was reached; refusing to report a truncated denominator.");
    process.exitCode = 1;
  }
  const summary = {
    runId,
    model,
    temperature,
    requireFirstPassThreshold,
    minimumRepairEligible,
    totalRequests: total,
    httpSuccess,
    sseToolSuccess,
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
    repairHistogram,
    errorSamples,
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
