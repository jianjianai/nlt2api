import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
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

test("v1 state migrates to v2 without assigning legacy accounts to groups", async () => {
  await withTempStore(async (store, dir) => {
    const file = join(dir, "accounts.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      settings: { recordMessages: false },
      accounts: [{
        id: "legacy-account",
        label: "Legacy",
        email: "legacy@example.com",
        password: "secret",
        enabled: true,
        weight: 1,
        models: ["model-a"],
        createdAt: timestamp(0),
        updatedAt: timestamp(0),
      }],
      proxyPool: [],
    }), "utf8");

    const state = await store.getState();
    assert.equal(state.version, 2);
    assert.deepEqual(state.accountGroups, []);
    assert.deepEqual(state.groupApiKeys, []);
    assert.deepEqual(state.accounts[0]?.groupIds, []);
    const persisted = JSON.parse(await readFile(file, "utf8")) as { version: number };
    assert.equal(persisted.version, 2);
  });
});

test("groups own account membership and store only API key digests", async () => {
  await withTempStore(async (store, dir) => {
    const first = await store.createAccountGroup({ name: "Primary", description: "Main capacity" });
    const second = await store.createAccountGroup({ name: "Overflow" });
    const account = await store.addAccount({
      email: "grouped@example.com",
      password: "secret",
      groupIds: [first.id, second.id, first.id],
    });
    assert.deepEqual(account.groupIds, [first.id, second.id]);

    const created = await store.createGroupApiKey(first.id, "Production");
    assert.match(created.secret, /^nwg_/);
    assert.equal((await store.authenticateGroupApiKey(created.secret))?.group.id, first.id);
    const persisted = await readFile(join(dir, "accounts.json"), "utf8");
    assert.equal(persisted.includes(created.secret), false);
    assert.equal(persisted.includes(created.key.secretDigest), true);

    const rotated = await store.rotateGroupApiKey(first.id, created.key.id);
    assert.notEqual(rotated.secret, created.secret);
    assert.equal(await store.authenticateGroupApiKey(created.secret), undefined);
    assert.equal((await store.authenticateGroupApiKey(rotated.secret))?.key.id, created.key.id);

    const removed = await store.deleteAccountGroup(first.id);
    assert.deepEqual(removed, { accountCount: 1, apiKeyCount: 1 });
    assert.deepEqual((await store.getAccount(account.id))?.groupIds, [second.id]);
    assert.deepEqual(await store.listGroupApiKeys(first.id), []);
  });
});

test("account pagination uses stable sorting and group filters", async () => {
  await withTempStore(async (store) => {
    const group = await store.createAccountGroup({ name: "Paged" });
    for (let index = 0; index < 21; index += 1) {
      await store.addAccount({
        email: `account-${String(index).padStart(2, "0")}@example.com`,
        password: "secret",
        label: `Account ${String(index).padStart(2, "0")}`,
        groupIds: index < 20 ? [group.id] : [],
      });
    }

    const first = await store.listAccountsPage({ page: 1, pageSize: 20, groupId: group.id, sort: "label_asc" });
    assert.equal(first.total, 20);
    assert.equal(first.pageCount, 1);
    assert.equal(first.accounts[0]?.label, "Account 00");
    assert.equal(first.accounts[19]?.label, "Account 19");
    const ungrouped = await store.listAccountsPage({ page: 1, pageSize: 20, groupId: null });
    assert.deepEqual(ungrouped.accounts.map((account) => account.label), ["Account 20"]);
  });
});

test("proxy pool settings and empty pool default for legacy state", async () => {
  await withTempStore(async (store) => {
    const settings = await store.getSettings();
    assert.deepEqual(settings.proxyPool, {
      autoAssignOnAccountCreate: false,
      autoRotateOnTransportError: false,
      retryCurrentRequestAfterRotation: true,
      directFallbackWhenExhausted: false,
      defaultImportProtocol: "http",
      healthCheckTimeoutSeconds: 10,
      errorRetryCooldownSeconds: 300,
    });
    assert.deepEqual(await store.listProxyPool(), []);
  });
});

test("proxy pool import, binding, health and deletion preserve account session", async () => {
  await withTempStore(async (store) => {
    const [created, duplicate] = await store.importProxyPool([
      { url: "socks5://user:pass@proxy.local:1080", kind: "socks5" },
      { url: "socks5://user:pass@proxy.local:1080", kind: "socks5" },
    ]);
    assert.equal(created?.created, true);
    assert.equal(duplicate?.created, false);
    assert.equal(created?.entry.id, duplicate?.entry.id);
    assert.equal((await store.listProxyPool()).length, 1);

    const account = await store.addAccount({ email: "pool@example.com", password: "secret" });
    await store.updateSession(account.id, { cookie: "nw_session=kept", expiresAt: null, updatedAt: timestamp(0) });
    const bound = await store.bindProxyPoolEntry(account.id, created!.entry.id);
    assert.equal(bound.proxyPoolEntryId, created?.entry.id);
    assert.equal(bound.proxy, created?.entry.url);
    assert.equal(bound.session?.cookie, "nw_session=kept");
    await assert.rejects(store.deleteProxyPoolEntry(created!.entry.id), /assigned/);

    const failed = await store.updateProxyPoolHealth(created!.entry.id, {
      healthy: false,
      checkedAt: timestamp(1),
      error: "connect failed",
      retryAfter: Date.parse(timestamp(1)) + 300_000,
    });
    assert.equal(failed.lastError, "connect failed");
    const healthy = await store.updateProxyPoolHealth(created!.entry.id, { healthy: true, checkedAt: timestamp(2) });
    assert.equal(healthy.lastError, undefined);

    const unbound = await store.unbindProxyPoolEntry(account.id, created!.entry.id);
    assert.equal(unbound.proxy, undefined);
    assert.equal(unbound.proxyPoolEntryId, undefined);
    assert.equal(unbound.session?.cookie, "nw_session=kept");
    await store.deleteProxyPoolEntry(created!.entry.id);
    assert.deepEqual(await store.listProxyPool(), []);
  });
});

test("manual proxy updates clear pool ownership but preserve session", async () => {
  await withTempStore(async (store) => {
    const [pool] = await store.importProxyPool([{ url: "http://pool.local:8080/", kind: "http" }]);
    const account = await store.addAccount({ email: "manual@example.com", password: "secret" });
    await store.updateSession(account.id, { cookie: "nw_session=kept", expiresAt: null, updatedAt: timestamp(0) });
    await store.bindProxyPoolEntry(account.id, pool!.entry.id);
    const updated = await store.updateAccount(account.id, { proxy: "http://manual.local:8080/" });
    assert.equal(updated.proxyPoolEntryId, undefined);
    assert.equal(updated.proxy, "http://manual.local:8080/");
    assert.equal(updated.session?.cookie, "nw_session=kept");
  });
});

test("scheduler settings default, persist and normalize invalid legacy values", async () => {
  await withTempStore(async (store, dir) => {
    assert.deepEqual((await store.getSettings()).scheduler, {
      accountModelConcurrency: 5,
      accountRpm: 20,
      proxyRpm: 30,
      directEgressLimitEnabled: false,
      directEgressRpm: 30,
      stickyTtlSeconds: 1_800,
      queueTimeoutSeconds: 0,
      maxQueueSize: 0,
    });

    await store.updateSettings({ scheduler: {
      accountModelConcurrency: 7,
      accountRpm: 25,
      proxyRpm: 40,
      directEgressLimitEnabled: true,
      directEgressRpm: 35,
      stickyTtlSeconds: 900,
      queueTimeoutSeconds: 45,
      maxQueueSize: 250,
    } });
    assert.equal((await store.getSettings()).scheduler.accountRpm, 25);

    const file = join(dir, "accounts.json");
    const parsed = JSON.parse(await readFile(file, "utf8")) as { settings: { scheduler: Record<string, unknown> } };
    parsed.settings.scheduler.accountRpm = -1;
    parsed.settings.scheduler.proxyRpm = "unlimited";
    parsed.settings.scheduler.queueTimeoutSeconds = -2;
    await writeFile(file, JSON.stringify(parsed), "utf8");
    const reloaded = await new StateStore().getSettings();
    assert.equal(reloaded.scheduler.accountRpm, 20);
    assert.equal(reloaded.scheduler.proxyRpm, 30);
    assert.equal(reloaded.scheduler.queueTimeoutSeconds, 0);
    assert.equal(reloaded.scheduler.accountModelConcurrency, 7);
  });
});

test("account scheduler overrides persist, clear, and prune removed models", async () => {
  await withTempStore(async (store) => {
    const account = await store.addAccount({ email: "limits@example.com", password: "secret", models: ["m1", "m2"] });
    const updated = await store.updateAccount(account.id, { schedulerOverrides: {
      accountRpm: 12,
      accountModelConcurrency: 4,
      modelConcurrency: { m1: 2, m2: 3, stale: 99 },
    } });
    assert.deepEqual(updated.schedulerOverrides, {
      accountRpm: 12,
      accountModelConcurrency: 4,
      modelConcurrency: { m1: 2, m2: 3 },
    });

    const pruned = await store.updateAccount(account.id, { models: ["m2"] });
    assert.deepEqual(pruned.schedulerOverrides?.modelConcurrency, { m2: 3 });
    const cleared = await store.updateAccount(account.id, { schedulerOverrides: null });
    assert.equal(cleared.schedulerOverrides, undefined);
  });
});

test("settings persist tool-call policy fields and clear on null or empty map", async () => {
  await withTempStore(async (store) => {
    await store.updateSettings({
      minimumOutputTokens: 0,
      toolCallFormat: "json",
      preambleVerbosity: "verbose",
      modelToolCallFormats: { "model-a": "xml", "model-b": "auto" },
      modelPreambleVerbosities: { "model-a": "quiet" },
    });
    const settings = await store.getSettings();
    assert.equal(settings.minimumOutputTokens, 0);
    assert.equal(settings.toolCallFormat, "json");
    assert.equal(settings.preambleVerbosity, "verbose");
    assert.deepEqual(settings.modelToolCallFormats, { "model-a": "xml", "model-b": "auto" });
    assert.deepEqual(settings.modelPreambleVerbosities, { "model-a": "quiet" });

    // Clearing with null / an empty map removes the overrides.
    await store.updateSettings({ toolCallFormat: null, modelToolCallFormats: {}, modelPreambleVerbosities: null });
    const cleared = await store.getSettings();
    assert.equal(cleared.toolCallFormat, undefined);
    assert.equal(cleared.modelToolCallFormats, undefined);
    assert.equal(cleared.modelPreambleVerbosities, undefined);
    assert.equal(cleared.preambleVerbosity, "verbose");
  });
});

test("persisted settings reload with invalid tool-call policy entries dropped", async () => {
  await withTempStore(async (store, dir) => {
    await store.updateSettings({ toolCallFormat: "xml", modelToolCallFormats: { "model-a": "json" } });
    const file = join(dir, "accounts.json");
    const parsed = JSON.parse(await readFile(file, "utf8")) as { settings: Record<string, unknown> };
    parsed.settings.minimumOutputTokens = 8193;
    parsed.settings.toolCallFormat = "yaml";
    parsed.settings.preambleVerbosity = "loud";
    parsed.settings.modelToolCallFormats = { "model-a": "json", "model-b": "yaml", "": "auto" };
    parsed.settings.modelPreambleVerbosities = { "model-a": "verbose", "model-b": "loud" };
    await writeFile(file, JSON.stringify(parsed), "utf8");
    const reloaded = new StateStore();
    const settings = await reloaded.getSettings();
    assert.equal(settings.minimumOutputTokens, undefined);
    assert.equal(settings.toolCallFormat, undefined);
    assert.equal(settings.preambleVerbosity, undefined);
    assert.deepEqual(settings.modelToolCallFormats, { "model-a": "json" });
    assert.deepEqual(settings.modelPreambleVerbosities, { "model-a": "verbose" });
  });
});

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

test("record summaries expose list metadata without bodies", async () => {
  await withTempStore(async (store) => {
    await store.updateSettings({ recordMessages: true });
    const record: DebugRecord = {
      id: "dbg_sum",
      at: timestamp(1),
      endpoint: "/v1/chat/completions",
      accountId: "acc-a",
      accountLabel: "主账号",
      clientRequest: {
        contentType: "application/json",
        body: JSON.stringify({
          messages: [
            { role: "user", content: "第一条消息" },
            { role: "assistant", content: "回复" },
            { role: "user", content: "  最后一条\n用户消息  " },
          ],
          tool_choice: "required",
        }),
      },
      upstreamCalls: [{
        sequence: 1,
        type: "initial",
        round: 1,
        attempt: 1,
        accountLabel: "主账号",
        responseStatus: 200,
        request: { contentType: "application/json", body: "{}" },
      }],
      toolCallAdapter: {
        toolCallExpected: "auto",
        initialParseSucceeded: true,
        finalParseSucceeded: true,
        initialOutcome: "tool_calls",
        finalOutcome: "tool_calls",
        repairAttempts: 0,
        maxRepairAttempts: 2,
        errors: [],
      },
      status: 200,
    };
    await store.appendDebugRecord(record);
    const summaries = await store.listDebugRecordSummaries();
    assert.equal(summaries.length, 1);
    const summary = summaries[0]!;
    assert.equal(summary.id, "dbg_sum");
    assert.equal(summary.preview, "最后一条 用户消息");
    assert.equal(summary.accountLabel, "主账号");
    assert.equal(summary.upstreamCalls?.length, 1);
    assert.equal(summary.upstreamCalls?.[0]?.sequence, 1);
    assert.ok(!("request" in (summary.upstreamCalls?.[0] ?? {})));
    assert.deepEqual(summary.toolCall, { forces: true, initialOutcome: "tool_calls", finalOutcome: "tool_calls" });
    assert.ok(!("clientRequest" in summary));
  });
});

test("record summaries preview Responses API input", async () => {
  await withTempStore(async (store) => {
    await store.updateSettings({ recordMessages: true });
    await store.appendDebugRecord({
      id: "dbg_resp_items",
      at: timestamp(1),
      endpoint: "/v1/responses",
      clientRequest: {
        contentType: "application/json",
        body: JSON.stringify({
          model: "gpt-5",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "第一条 输入" }] },
            { type: "function_call_output", call_id: "call_1", output: { content: [{ type: "output_text", text: "工具结果" }] } },
            { type: "message", role: "user", content: [{ type: "input_text", text: "最后一条 输入" }] },
          ],
        }),
      },
      status: 200,
    });
    await store.appendDebugRecord({
      id: "dbg_resp_string",
      at: timestamp(2),
      endpoint: "/v1/responses",
      clientRequest: {
        contentType: "application/json",
        body: JSON.stringify({ model: "gpt-5", input: "字符串 输入" }),
      },
      status: 200,
    });
    const summaries = await store.listDebugRecordSummaries();
    assert.equal(summaries[0]?.preview, "字符串 输入");
    assert.equal(summaries[0]?.model, "gpt-5");
    assert.equal(summaries[1]?.preview, "最后一条 输入");
  });
});

test("getDebugRecord loads a single full record on demand", async () => {
  await withTempStore(async (store) => {
    await store.updateSettings({ recordMessages: true });
    await store.appendDebugRecord(makeRecord("dbg_one", timestamp(1)));
    const record = await store.getDebugRecord("dbg_one");
    assert.equal(record?.id, "dbg_one");
    assert.equal(record?.clientRequest.body, "{}");
    assert.equal(await store.getDebugRecord("dbg_missing"), undefined);
  });
});

test("a fresh store reuses the persisted record index while it matches disk", async () => {
  await withTempStore(async (store, dir) => {
    await store.updateSettings({ recordMessages: true });
    await store.appendDebugRecord(makeRecord("dbg_p1", timestamp(1)));
    await store.appendDebugRecord(makeRecord("dbg_p2", timestamp(2)));
    const persisted = JSON.parse(await readFile(join(dir, "records-index.json"), "utf8")) as { version: number; entries: unknown[] };
    assert.equal(persisted.version, 2);
    assert.equal(persisted.entries.length, 2);

    const rebuilt = new StateStore();
    assert.deepEqual((await rebuilt.listDebugRecordSummaries()).map((summary) => summary.id), ["dbg_p2", "dbg_p1"]);

    // A corrupt persisted index falls back to parsing the record files.
    await writeFile(join(dir, "records-index.json"), "not json", "utf8");
    const recovered = new StateStore();
    assert.deepEqual((await recovered.listDebugRecordSummaries()).map((summary) => summary.id), ["dbg_p2", "dbg_p1"]);

    // A stale index (files changed externally) is discarded and rebuilt.
    await unlink(join(dir, "records", "dbg_p2.json"));
    const stale = new StateStore();
    assert.deepEqual((await stale.listDebugRecordSummaries()).map((summary) => summary.id), ["dbg_p1"]);
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
