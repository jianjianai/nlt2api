// Two-turn end-to-end check: turn 1 forces a markup-bearing edit_file call;
// turn 2 sends the tool result back and forces another call. The turn-2
// upstream request must carry the turn-1 call re-encoded with CDATA values.
const baseUrl = process.env.NEURALWATT_PROBE_BASE_URL || "http://localhost:3100";
const clientKey = process.env.NEURALWATT_PROBE_CLIENT_KEY;
const model = process.argv[2] || "deepseek-v4-pro";
const runId = `hist-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const editTool = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Edit a file.",
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
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    strict: true,
  },
};

async function chat(messages, turn) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: [editTool],
      tool_choice: { type: "function", function: { name: "edit_file" } },
      temperature: 0,
      max_completion_tokens: 2048,
      user: `${runId}-${turn}`,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 200)}`);
  return payload.choices?.[0]?.message;
}

const turn1Prompt = `Edit app/App.vue: replace '<span class="chip">{{ s }}</span>' with '<span class="chip" :class="s < 400 ? \'ok\' : \'err\'">{{ s }}</span>'. Call edit_file.`;
const turn1 = await chat([{ role: "user", content: turn1Prompt }], 1);
if (!turn1?.tool_calls?.length) throw new Error("turn 1 produced no tool call");
console.log("turn1 args:", turn1.tool_calls[0].function.arguments.slice(0, 160));

const turn2 = await chat([
  { role: "user", content: turn1Prompt },
  { role: "assistant", content: turn1.content ?? null, tool_calls: turn1.tool_calls },
  { role: "tool", tool_call_id: turn1.tool_calls[0].id, content: "edit applied" },
  { role: "user", content: "Now edit app/Other.vue the same way: replace '<b>0</b>' with '<b>1</b>'. Call edit_file." },
], 2);
if (!turn2?.tool_calls?.length) throw new Error("turn 2 produced no tool call");
console.log("turn2 args:", turn2.tool_calls[0].function.arguments.slice(0, 160));
console.log(JSON.stringify({ runId, ok: true }));
