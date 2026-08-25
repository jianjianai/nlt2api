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

test("account creation validates count", async () => {
  await withAdminStore(async (handler) => {
    const invalid = await handler(event({ count: 0 }));
    assert.equal(invalid.status, 400);
    const payload = await invalid.json() as { error?: { param?: string } };
    assert.equal(payload.error?.param, "count");
  });
});

test("account creation reports insufficient healthy proxies without creating empty accounts", async () => {
  await withAdminStore(async (handler) => {
    const response = await handler(event({ count: 2 }));
    assert.equal(response.status, 409);
    const payload = await response.json() as { requested?: number; created?: number; accounts?: unknown[] };
    assert.equal(payload.requested, 2);
    assert.equal(payload.created, 0);
    assert.deepEqual(payload.accounts, []);
  });
});
