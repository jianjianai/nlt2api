import { readFileSync } from "node:fs";
import { ConfigError, loadConfig } from "./config.ts";
import { MinterClient } from "./client.ts";

function version(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[minter] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  console.log(`[minter] agent ${config.agentId} → ${config.wsUrl} (concurrency ${config.concurrency})`);
  const client = new MinterClient({ config, version: version() });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[minter] received ${signal}`);
    void client.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await client.start();
}

await main();
