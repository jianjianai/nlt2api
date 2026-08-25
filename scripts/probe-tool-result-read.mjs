// Small focused test: can the upstream model actually READ a `role: "tool"`
// (tool-result) message?
//
// The gateway forwards client history to the DeepInfra portal, including tool
// result messages. If the portal model silently ignores `tool` role messages,
// it will re-ask for information that already arrived (e.g. re-reading the
// same file). This probe puts a unique secret ONLY inside a tool message and
// asks the model to repeat it. A control case puts the same secret in a plain
// user message so we can tell "cannot see tool messages" apart from "cannot
// follow the instruction".

const baseUrl = process.env.DEEPINFRA_PROBE_BASE_URL || "http://localhost:3000";
const model = process.env.DEEPINFRA_PROBE_MODEL || process.env.DEEPINFRA_GATEWAY_DEFAULT_MODEL || "kimi-k3-fast";
const clientKey = process.env.DEEPINFRA_PROBE_CLIENT_KEY || process.env.DEEPINFRA_GATEWAY_API_KEY;

if (!clientKey) {
  throw new Error("Missing DEEPINFRA_PROBE_CLIENT_KEY (or DEEPINFRA_GATEWAY_API_KEY).");
}

const secret = `NW_TOOL_SECRET_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const headers = {
  authorization: `Bearer ${clientKey}`,
  "content-type": "application/json",
};

function ask(placement) {
  const history = [
    {
      role: "user",
      content:
        "There is a secret code somewhere in this conversation. Find it and reply with ONLY the secret code, no other text.",
    },
  ];
  if (placement === "tool") {
    history.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_secret_1",
            type: "function",
            function: { name: "lookup_secret", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_secret_1",
        content: `The secret code is ${secret}.`,
      },
    );
  } else {
    history.push({ role: "user", content: `The secret code is ${secret}.` });
  }
  return {
    model,
    messages: history,
    temperature: 0,
    max_tokens: 64,
    stream: false,
  };
}

function findSecret(text) {
  return typeof text === "string" && text.includes(secret);
}

const results = [];
for (const placement of ["tool", "user"]) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(ask(placement)),
  });
  const body = await response.text();
  let content = "";
  let error = "";
  try {
    const parsed = JSON.parse(body);
    content = parsed?.choices?.[0]?.message?.content ?? "";
    error = parsed?.error?.message ?? "";
  } catch {
    error = `non-JSON response (HTTP ${response.status}): ${body.slice(0, 200)}`;
  }
  const found = findSecret(content);
  results.push({
    placement,
    httpStatus: response.status,
    found,
    content: content.slice(0, 200),
    error: error.slice(0, 200),
  });
  console.log(`[${placement}] secret=${secret} http=${response.status} found=${found}`);
  console.log(`  content=${JSON.stringify(content.slice(0, 200))}`);
  if (error) console.log(`  error=${JSON.stringify(error)}`);
}

const toolCase = results.find((r) => r.placement === "tool");
const controlCase = results.find((r) => r.placement === "user");
const summary = {
  secret,
  model,
  toolMessageReadable: Boolean(toolCase?.found),
  controlReadable: Boolean(controlCase?.found),
  verdict:
    toolCase?.found
      ? "TOOL_MESSAGE_READABLE: the upstream model can read `role: tool` results."
      : controlCase?.found
        ? "TOOL_MESSAGE_NOT_READABLE: the model reads the same text from a user message but not from a `role: tool` message."
        : "INCONCLUSIVE: the model did not repeat the secret from either placement.",
  results,
};
console.log(`\n${JSON.stringify(summary, null, 2)}`);
