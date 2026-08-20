import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetProxyConfigForTests } from "../server/utils/config.ts";
import { StateStore } from "../server/utils/state-store.ts";
import type { DebugRecord } from "../server/utils/types.ts";

function makeRecord(id: string, at: string, accountId?: string): DebugRecord {
  return {
    id,
    at,
    endpoint: "/v1/chat/completions",
    ...(accountId ? { accountId } : {}),
    clientRequest: { contentType: "application/json", body: "{}" },
    status: 200,
  };
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2025, 0, 1, 0, 0, offsetSeconds)).toISOString();
}

async function withTempStore<T>(run: (store: StateStore, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "neuralwatt-state-test-"));
  const previous = process.env.NEURALWATT_DATA_DIR;
  process.env.NEURALWATT_DATA_DIR = dir;
  resetProxyConfigForTests();
  try {
    return await run(new StateStore(), dir);
  } finally {
    if (previous === undefined) {
      delete process.env.NEURALWATT_DATA_DIR;
    } else {
      process.env.NEURALWATT_DATA_DIR = previous;
    }
    resetProxyConfigForTests();
    await rm(dir, { recursive: true, force: true });
  }
}

async function recordFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dir, "records"));
    return entries.filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

test("debug records are skipped while recordMessages is disabled", async () => {
  await withTempStore(async (store, dir) => {
    await store.appendDebugRecord(makeRecord("dbg_off", timestamp(0)));
    assert.deepEqual(await recordFiles(dir), []);
    assert.deepEqual(await store.listDebugRecords(), []);
  });
});

test("debug records list newest first after appends", async () => {
  await withTempStore(async (store) => {
    await store.updateSettings({ recordMessages: true });
    await store.appendDebugRecord(makeRecord("dbg_1", timestamp(1)));
    await store.appendDebugRecord(makeRecord("dbg_2", timestamp(2)));
    await store.appendDebugRecord(makeRecord("dbg_3", timestamp(3)));
    const records = await store.listDebugRecords();
    assert.deepEqual(records.map((record) => record.id), ["dbg_3", "dbg_2", "dbg_1"]);
  });
});

test("debug record pruning keeps only the newest 500 files", async () => {
  await withTempStore(async (store, dir) => {
    await store.updateSettings({ recordMessages: true });
    const total = 505;
    for (let index = 0; index < total; index += 1) {
      const id = `dbg_${String(index).padStart(4, "0")}`;
      await store.appendDebugRecord(makeRecord(id, timestamp(index)));
    }
    const files = await recordFiles(dir);
    assert.equal(files.length, 500);
    for (let index = 0; index < total - 500; index += 1) {
      assert.ok(!files.includes(`dbg_${String(index).padStart(4, "0")}.json`));
    }
    const records = await store.listDebugRecords(500);
    assert.equal(records.length, 500);
    assert.equal(records[0]?.id, `dbg_${String(total - 1).padStart(4, "0")}`);
    assert.equal(records[records.length - 1]?.id, `dbg_${String(total - 500).padStart(4, "0")}`);
  });
});

test("a fresh store rebuilds the record index from disk in timestamp order", async () => {
  await withTempStore(async (store) => {
    await store.updateSettings({ recordMessages: true });
    await store.appendDebugRecord(makeRecord("dbg_b", timestamp(2)));
    await store.appendDebugRecord(makeRecord("dbg_a", timestamp(1)));
    await store.appendDebugRecord(makeRecord("dbg_c", timestamp(3)));
    const rebuilt = new StateStore();
    const records = await rebuilt.listDebugRecords();
    assert.deepEqual(records.map((record) => record.id), ["dbg_c", "dbg_b", "dbg_a"]);
  });
});

test("deleting records for an account keeps the index and disk in sync", async () => {
  await withTempStore(async (store, dir) => {
    await store.updateSettings({ recordMessages: true });
    await store.appendDebugRecord(makeRecord("dbg_a1", timestamp(1), "acc-a"));
    await store.appendDebugRecord(makeRecord("dbg_b1", timestamp(2), "acc-b"));
    await store.appendDebugRecord(makeRecord("dbg_a2", timestamp(3), "acc-a"));
    const removed = await store.deleteDebugRecordsForAccount("acc-a");
    assert.equal(removed, 2);
    assert.deepEqual((await store.listDebugRecords()).map((record) => record.id), ["dbg_b1"]);
    assert.deepEqual(await recordFiles(dir), ["dbg_b1.json"]);
    assert.equal(await store.deleteDebugRecordsForAccount("acc-a"), 0);
  });
});

test("deleting all records clears both the index and the directory", async () => {
  await withTempStore(async (store, dir) => {
    await store.updateSettings({ recordMessages: true });
    await store.appendDebugRecord(makeRecord("dbg_1", timestamp(1)));
    await store.appendDebugRecord(makeRecord("dbg_2", timestamp(2)));
    assert.equal(await store.deleteAllDebugRecords(), 2);
    assert.deepEqual(await recordFiles(dir), []);
    assert.deepEqual(await store.listDebugRecords(), []);
    await store.appendDebugRecord(makeRecord("dbg_3", timestamp(3)));
    assert.deepEqual((await store.listDebugRecords()).map((record) => record.id), ["dbg_3"]);
  });
});

test("concurrent appends produce unique index entries and files", async () => {
  await withTempStore(async (store, dir) => {
    await store.updateSettings({ recordMessages: true });
    const ids = Array.from({ length: 20 }, (_, index) => `dbg_c${String(index).padStart(2, "0")}`);
    await Promise.all(ids.map((id, index) => store.appendDebugRecord(makeRecord(id, timestamp(index)))));
    const records = await store.listDebugRecords(50);
    assert.equal(records.length, 20);
    assert.equal(new Set(records.map((record) => record.id)).size, 20);
    assert.equal((await recordFiles(dir)).length, 20);
  });
});
