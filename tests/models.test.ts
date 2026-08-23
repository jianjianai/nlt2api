import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { stateStore } from "../server/utils/state-store.ts";
import { accountScheduler } from "../server/utils/account-scheduler.ts";
import { assertModelSupported } from "../server/utils/chat-service.ts";
import { HttpError } from "../server/utils/http.ts";

async function withTempStore<T>(run: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "neuralwatt-models-test-"));
  const previous = process.env.NEURALWATT_DATA_DIR;
  process.env.NEURALWATT_DATA_DIR = dir;
  resetProxyConfigForTests();
  stateStore.resetForTests();
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.NEURALWATT_DATA_DIR;
    } else {
      process.env.NEURALWATT_DATA_DIR = previous;
    }
    resetProxyConfigForTests();
    stateStore.resetForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

function accountInput(email: string, models?: string[]) {
  return {
    email,
    password: "secret",
    label: email,
    ...(models ? { models } : {}),
  };
}

test("account models are normalised, deduplicated and trimmed", async () => {
  await withTempStore(async () => {
    const account = await stateStore.addAccount(accountInput("a@example.com", ["m1", " m2 ", "m1", "", "m3"]));
    assert.deepEqual(account.models, ["m1", "m2", "m3"]);
  });
});

test("mergeAccountModels appends and deduplicates without replacing manual entries", async () => {
  await withTempStore(async () => {
    const account = await stateStore.addAccount(accountInput("a@example.com", ["manual-a", "shared"]));
    const merged = await stateStore.mergeAccountModels(account.id, ["shared", "fetched-b", "fetched-b"]);
    assert.deepEqual(merged.models, ["manual-a", "shared", "fetched-b"]);
  });
});

test("updateAccount replaces the model list", async () => {
  await withTempStore(async () => {
    const account = await stateStore.addAccount(accountInput("a@example.com", ["old"]));
    const updated = await stateStore.updateAccount(account.id, { models: ["new-a", "new-a", "new-b"] });
    assert.deepEqual(updated.models, ["new-a", "new-b"]);
  });
});

test("legacy accounts without models load with an empty list", async () => {
  await withTempStore(async () => {
    const account = await stateStore.addAccount(accountInput("a@example.com"));
    assert.deepEqual(account.models, []);
  });
});

test("assertModelSupported rejects models no enabled account supports", async () => {
  await withTempStore(async () => {
    await stateStore.addAccount(accountInput("a@example.com", ["m1"]));
    await assertModelSupported("m1");
    await assert.rejects(
      assertModelSupported("missing"),
      (error: unknown) => error instanceof HttpError
        && error.status === 404
        && error.code === "model_not_supported",
    );
  });
});

test("assertModelSupported reports disabled accounts as temporarily unavailable", async () => {
  await withTempStore(async () => {
    const account = await stateStore.addAccount(accountInput("a@example.com", ["m1"]));
    await stateStore.updateAccount(account.id, { enabled: false });
    await assert.rejects(
      assertModelSupported("m1"),
      (error: unknown) => error instanceof HttpError
        && error.status === 503
        && error.code === "no_account_available",
    );
  });
});

test("assertModelSupported reports no enabled accounts as unavailable", async () => {
  await withTempStore(async () => {
    await assert.rejects(
      assertModelSupported("m1"),
      (error: unknown) => error instanceof HttpError
        && error.status === 503
        && error.code === "no_account_available",
    );
  });
});

test("scheduler routes only to accounts supporting the requested model", async () => {
  await withTempStore(async () => {
    const a = await stateStore.addAccount(accountInput("a@example.com", ["m1"]));
    const b = await stateStore.addAccount(accountInput("b@example.com", ["m2"]));
    const lease = await accountScheduler.acquire({ model: "m2" });
    assert.equal(lease.account.id, b.id);
    lease.release();
    accountScheduler.remove(a.id);
    accountScheduler.remove(b.id);
  });
});

test("scheduler fails when no account supports the requested model", async () => {
  await withTempStore(async () => {
    const a = await stateStore.addAccount(accountInput("a@example.com", ["m1"]));
    await assert.rejects(
      accountScheduler.acquire({ model: "m2" }),
      /No enabled NeuralWatt account is currently available/,
    );
    accountScheduler.remove(a.id);
  });
});

test("scheduler routes across accounts that support the requested model", async () => {
  await withTempStore(async () => {
    const a = await stateStore.addAccount(accountInput("a@example.com", ["m1"]));
    const b = await stateStore.addAccount(accountInput("b@example.com", ["m1"]));
    const lease = await accountScheduler.acquire({ model: "m1" });
    assert.ok([a.id, b.id].includes(lease.account.id));
    lease.release();
    accountScheduler.remove(a.id);
    accountScheduler.remove(b.id);
  });
});
