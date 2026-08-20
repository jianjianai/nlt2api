// Probe: for kimi-k3, compare thinking continuation with and without the
// trailing user message. A partial reasoning that cuts off mid-calculation
// is planted in a trailing assistant message; the response shows whether the
// model continues the thought (prefill) or restarts, and whether the final
// answer is produced.
//
// Usage: node scripts/probe-continuation-compare.mjs [model]
import { readFile } from "node:fs/promises";

const state = JSON.parse(await readFile(new URL("../.data/neuralwatt/accounts.json", import.meta.url), "utf8"));
const account = state.accounts.find((item) => item.enabled && item.session?.cookie);
if (!account) {
  throw new Error("No enabled account with a session in .data/neuralwatt/accounts.json");
}
const cookie = account.session.cookie;

const PORTAL = "https://portal.neuralwatt.com";
const model = process.argv[2] || "kimi-k3";

const user = { role: "user", content: "17乘以23等于多少？" };
// Cut off mid-verification: 17 × 23 = 391, cross-check 23×10 + 23×7 = 230 + 161 = …
const planted =
  "用户问 17 乘以 23。让我计算一下。17 × 23 = 17 × 20 + 17 × 3 = 340 + 51 = 391。所以答案应该是 391。不过让我验证一下：换成分解 23 × 17，23 × 10 = 230，23 × 7 = 161，230 + 161 =";

const CONTINUE_PROMPT =
  "Continue the previous response from exactly where it ended. Do not repeat any text. Finish the answer if possible.";

async function probe(name, messages) {
  const started = Date.now();
  const response = await fetch(`${PORTAL}/api/chat`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json, text/event-stream",
      Cookie: cookie,
      Origin: PORTAL,
      Referer: `${PORTAL}/playground`,
      "User-Agent": "neuralwatt-openai-compat/1.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: 2048, temperature: 0 }),
  });
  const text = await response.text();
  console.log(`\n=== ${name} ===`);
  console.log("status:", response.status, `| ${Date.now() - started}ms`);
  try {
    const json = JSON.parse(text);
    const message = json.choices?.[0]?.message;
    console.log("finish_reason:", json.choices?.[0]?.finish_reason, "| usage:", JSON.stringify(json.usage ?? null));
    console.log("reasoning:", JSON.stringify(message?.reasoning ?? message?.reasoning_content ?? null));
    console.log("content:", JSON.stringify(message?.content ?? null));
  } catch {
    console.log("raw:", text.slice(0, 1000));
  }
}

// A: prefill only — trailing assistant message, no user message.
await probe("A: no trailing user message", [
  user,
  { role: "assistant", content: "", reasoning: planted },
]);

// B: current shape — trailing assistant message + Continue user message.
await probe("B: with Continue user message", [
  user,
  { role: "assistant", content: "", reasoning: planted },
  { role: "user", content: CONTINUE_PROMPT },
]);
