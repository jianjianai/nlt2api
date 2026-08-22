import fs from "node:fs";

const dir = ".data/neuralwatt/records";
const runId = process.argv[2];
const filter = process.argv[3];
if (!runId) throw new Error("usage: node scripts/dump-run-failures.mjs <runId> [filter]");

for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".json"))) {
  const record = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8"));
  let user;
  try {
    user = JSON.parse(record.clientRequest?.body || "{}").user;
  } catch {
    continue;
  }
  if (typeof user !== "string" || !user.startsWith(runId)) continue;
  if (filter && !user.includes(filter)) continue;
  const trace = record.toolCallAdapter || {};
  if (trace.initialOutcome === "tool_calls") continue;
  console.log(`===== ${user} =====`);
  for (const call of record.upstreamCalls || []) {
    console.log(`--- upstream call #${call.sequence} type=${call.type} status=${call.responseStatus ?? "?"}`);
    if (call.type === "initial" && call.response?.body) {
      const body = call.response.body;
      if (call.response.contentType === "text/event-stream") {
        // Reassemble the assistant content from SSE frames.
        let content = "";
        for (const line of body.split(/\r?\n/)) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const frame = JSON.parse(data);
            const delta = frame.choices?.[0]?.delta;
            if (typeof delta?.content === "string") content += delta.content;
          } catch { /* ignore */ }
        }
        console.log("RAW MODEL OUTPUT:");
        console.log(content.slice(0, 3000));
      } else {
        console.log(body.slice(0, 3000));
      }
    }
  }
}
