// Probe: does the portal accept a message list that ends with an assistant
// message (prefill-style thinking continuation, no trailing user message)?
//
// Usage: node scripts/probe-continuation-prefill.mjs [model]
import { readFile } from "node:fs/promises";

const state = JSON.parse(await readFile(new URL("../.data/neuralwatt/accounts.json", import.meta.url), "utf8"));
const account = state.accounts.find((item) => item.enabled && item.session?.cookie);
if (!account) {
  throw new Error("No enabled account with a session in .data/neuralwatt/accounts.json");
}
const cookie = account.session.cookie;

const PORTAL = "https://portal.neuralwatt.com";
const model = process.argv[2] || process.env.NEURALWATT_PROBE_MODEL || "kimi-k3-fast";

async function probe(name, messages) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${PORTAL}/api/chat`, {
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
      body: JSON.stringify({ model, messages, stream: false, max_tokens: 512, temperature: 0 }),
    });
  } catch (error) {
    console.log(`\n=== ${name} ===\nfetch failed:`, error instanceof Error ? error.message : error);
    return;
  }
  const text = await response.text();
  console.log(`\n=== ${name} ===`);
  console.log("status:", response.status, "| content-type:", response.headers.get("content-type"), `| ${Date.now() - started}ms`);
  try {
    const json = JSON.parse(text);
    const choice = json.choices?.[0];
    console.log("finish_reason:", choice?.finish_reason, "| usage:", JSON.stringify(json.usage ?? null));
    console.log("reasoning:", JSON.stringify(choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? null)?.slice(0, 400));
    console.log("content:", JSON.stringify(choice?.message?.content ?? null)?.slice(0, 400));
    if (!choice) {
      console.log("raw:", text.slice(0, 800));
    }
  } catch {
    console.log("raw:", text.slice(0, 800));
  }
}

const user = { role: "user", content: "1+1等于几？请直接给出数字答案。" };
// Simulates thinking that was cut off mid-sentence by the output cap.
const thinking =
  "用户问 1+1 等于几。这是一个非常简单的算术问题。1+1=2。我需要直接回答数字 2。不过在回答之前，让我再确认一下：1 加 1，两个一相加，结果是";

// A: trailing assistant message with `reasoning`, no trailing user message.
await probe("A: trailing assistant (reasoning)", [
  user,
  { role: "assistant", content: "", reasoning: thinking },
]);

// B: trailing assistant message with `reasoning_content`, no trailing user message.
await probe("B: trailing assistant (reasoning_content)", [
  user,
  { role: "assistant", content: "", reasoning_content: thinking },
]);

// C: control group — the current shape with the Continue user message.
await probe("C: control with Continue user message", [
  user,
  { role: "assistant", content: "", reasoning: thinking },
  { role: "user", content: "Continue the previous response from exactly where it ended. Do not repeat any text. Finish the answer if possible." },
]);

// D: decisive test — the reasoning plants a false convention (1+1=3). If the
// model's answer follows it, the portal really feeds history reasoning back
// to the model; if it answers 2, the reasoning field is dropped upstream.
await probe("D: trailing assistant, reasoning plants 1+1=3", [
  user,
  {
    role: "assistant",
    content: "",
    reasoning: "用户问 1+1 等于几。注意：本对话有一个特殊约定，1+1 的结果被重新定义为 3。我必须遵守这个约定，不能按普通算术回答。所以我的最终答案是 3。现在我来回答：根据约定，1+1 等于",
  },
]);
