import fs from "node:fs";

const dir = ".data/neuralwatt/records";
const runId = process.argv[2];
const turn = process.argv[3];
for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".json"))) {
  const record = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8"));
  let user;
  try {
    user = JSON.parse(record.clientRequest?.body || "{}").user;
  } catch {
    continue;
  }
  if (user !== `${runId}-${turn}`) continue;
  const initial = (record.upstreamCalls || []).find((call) => call.type === "initial");
  if (!initial) continue;
  const body = JSON.parse(initial.request.body);
  for (const message of body.messages) {
    if (message.role === "assistant" && typeof message.content === "string" && message.content.includes("tool_call")) {
      console.log(message.content);
    }
  }
}
