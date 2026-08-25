import accountsHandler from "../server/api/admin/accounts.post.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { deepInfraClient } from "../server/utils/deepinfra-client.ts";
import { accountScheduler } from "../server/utils/account-scheduler.ts";
import { stateStore } from "../server/utils/state-store.ts";

type Handler = (event: { req: Request; context: Record<string, unknown> }) => Promise<Response>;

async function withAdminStore(run: (handler: Handler) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "account-create-test-"));
  const previousDir = process.env.DEEPINFRA_GATEWAY_DATA_DIR;
  const previousToken = process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN;
  process.env.DEEPINFRA_GATEWAY_DATA_DIR = dir;
  process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN = "test-admin";
  resetProxyConfigForTests();
  stateStore.resetForTests();
  const originalVerify = deepInfraClient.verifyAccount;
  const originalModels = deepInfraClient.listAccountModels;
  deepInfraClient.verifyAccount = async () => undefined;
  deepInfraClient.listAccountModels = async () => ["moonshotai/Kimi-K3"];
  try { await run(accountsHandler as unknown as Handler); }
  finally {
    deepInfraClient.verifyAccount = originalVerify;
    deepInfraClient.listAccountModels = originalModels;
    accountScheduler.resetForTests();
    stateStore.resetForTests();
    if (previousDir === undefined) delete process.env.DEEPINFRA_GATEWAY_DATA_DIR; else process.env.DEEPINFRA_GATEWAY_DATA_DIR = previousDir;
    if (previousToken === undefined) delete process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN; else process.env.DEEPINFRA_GATEWAY_ADMIN_TOKEN = previousToken;
    resetProxyConfigForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

function event(body: Record<string, unknown>): { req: Request; context: Record<string, unknown> } {
  return { req: new Request("http://localhost/api/admin/accounts", { method: "POST", headers: { "x-admin-token": "test-admin", "content-type": "application/json" }, body: JSON.stringify(body) }), context: {} };
}

test("account creation rejects a second direct account with a clear conflict", async () => {
  await withAdminStore(async (handler) => {
    assert.equal((await handler(event({ label: "Direct" }))).status, 201);
    const duplicate = await handler(event({ label: "Duplicate direct" }));
    assert.equal(duplicate.status, 409);
    const payload = await duplicate.json() as { error?: { code?: string; param?: string } };
    assert.equal(payload.error?.code, "egress_already_assigned");
    assert.equal(payload.error?.param, "proxy");
  });
});

test("account creation succeeds with a unique proxy after direct is occupied", async () => {
  await withAdminStore(async (handler) => {
    assert.equal((await handler(event({ label: "Direct" }))).status, 201);
    const response = await handler(event({ label: "Proxy", proxy: "socks5h://proxy.example:1080" }));
    assert.equal(response.status, 201);
    const payload = await response.json() as { account?: { proxy?: string; models?: string[] } };
    assert.equal(payload.account?.proxy, "socks5h://proxy.example:1080");
    assert.deepEqual(payload.account?.models, ["moonshotai/Kimi-K3"]);
  });
});
