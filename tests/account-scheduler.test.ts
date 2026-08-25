import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountScheduler,
  SchedulerAdmissionError,
  type AccountLease,
  type AccountSchedulerDependencies,
} from "../server/utils/account-scheduler.ts";
import { openAIErrorResponse } from "../server/utils/http.ts";
import { egressIdentity } from "../server/utils/proxy.ts";
import { DEFAULT_PROXY_POOL_SETTINGS, DEFAULT_SCHEDULER_SETTINGS } from "../server/utils/types.ts";
import type { ManagedAccount, ProxySettings, SchedulerSettings } from "../server/utils/types.ts";

type TimerHandle = ReturnType<typeof setTimeout>;

class FakeClock {
  nowMs = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.nowMs;

  setTimer = (callback: () => void, delayMs: number): TimerHandle => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.nowMs + Math.max(0, delayMs), callback });
    return id as unknown as TimerHandle;
  };

  clearTimer = (handle: TimerHandle): void => {
    this.timers.delete(handle as unknown as number);
  };

  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) break;
      for (const [id, timer] of due) {
        this.timers.delete(id);
        timer.callback();
      }
      await flush();
    }
  }
}

function account(id: string, models = ["m1"], proxy?: string): ManagedAccount {
  return {
    id,
    label: id,
        enabled: true,
    weight: 1,
    ...(proxy ? { proxy } : {}),
    groupIds: [],
    models,
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function settings(overrides: Partial<SchedulerSettings> = {}): ProxySettings {
  return {
    recordMessages: false,
    scheduler: { ...DEFAULT_SCHEDULER_SETTINGS, ...overrides },
    proxyPool: { ...DEFAULT_PROXY_POOL_SETTINGS },
  };
}

function harness(accounts: ManagedAccount[], initial: Partial<SchedulerSettings> = {}) {
  const clock = new FakeClock();
  let currentSettings = settings(initial);
  const dependencies: AccountSchedulerDependencies = {
    listAccounts: async () => accounts,
    getSettings: async () => currentSettings,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  const scheduler = new AccountScheduler(dependencies);
  return {
    clock,
    scheduler,
    updateSettings(update: Partial<SchedulerSettings>) {
      currentSettings = settings({ ...currentSettings.scheduler, ...update });
      scheduler.notifyStateChanged();
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function resolved<T>(promise: Promise<T>): Promise<T> {
  await flush();
  return promise;
}

async function pending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  return !settled;
}

function releaseAll(leases: AccountLease[]): void {
  for (const lease of leases) lease.release();
}

test("account/model concurrency queues only the full model and wakes one waiter", async () => {
  const { scheduler } = harness([account("a", ["m1", "m2"])], { accountModelConcurrency: 2 });
  const first = await resolved(scheduler.acquire({ model: "m1" }));
  const second = await resolved(scheduler.acquire({ model: "m1" }));
  const thirdPromise = scheduler.acquire({ model: "m1" });
  assert.equal(await pending(thirdPromise), true);

  const otherModel = await resolved(scheduler.acquire({ model: "m2" }));
  assert.equal(otherModel.account.id, "a");
  first.release();
  const third = await resolved(thirdPromise);
  assert.equal(third.account.id, "a");
  assert.equal(scheduler.publicState(third.account).runtime.modelInFlight.m1, 2);

  second.release();
  third.release();
  otherModel.release();
  otherModel.release();
  assert.equal(scheduler.publicState(otherModel.account).runtime.inFlight, 0);
});

test("account RPM retains admitted attempts and wakes at the rolling-window edge", async () => {
  const { scheduler, clock } = harness([account("a")], { accountRpm: 2, accountModelConcurrency: 10 });
  const first = await resolved(scheduler.acquire({ model: "m1" }));
  const second = await resolved(scheduler.acquire({ model: "m1" }));
  releaseAll([first, second]);

  const thirdPromise = scheduler.acquire({ model: "m1" });
  assert.equal(await pending(thirdPromise), true);
  await clock.advance(59_999);
  assert.equal(await pending(thirdPromise), true);
  await clock.advance(1);
  const third = await resolved(thirdPromise);
  assert.equal(third.account.id, "a");
  third.release();
});

test("proxy aliases and credentials share one normalized egress identity", () => {
  const identities = [
    "socks://one:a@proxy.example:1080",
    "socks5://two:b@PROXY.example:1080",
    "socks5h://three:c@proxy.example",
  ].map((proxy) => egressIdentity(proxy).key);
  assert.equal(new Set(identities).size, 1);
  assert.equal(egressIdentity("socks4://a@proxy.example").key, egressIdentity("socks4a://b@PROXY.example:1080").key);
});

test("one DeepInfra gateway schedules independent egress accounts", async () => {
  const direct = account("direct", ["shared-model"], "socks5h://egress-a.example:1080");
  const proxy = account("proxy", ["shared-model"], "socks5h://egress-b.example:1080");
  const { scheduler } = harness([direct, proxy], {
    accountModelConcurrency: 1,
    accountRpm: 100,
    proxyRpm: 100,
  });

  // The caller asks only for a model; the scheduler chooses an egress account.
  const first = await resolved(scheduler.acquire({ model: "shared-model" }));
  const second = await resolved(scheduler.acquire({ model: "shared-model" }));
  assert.notEqual(first.account.id, second.account.id);
  assert.notEqual(first.egressId, second.egressId);

  first.release();
  second.release();

  // Completed serial requests remain part of the rolling weighted load, so equal
  // accounts rotate instead of pinning every request to the oldest account.
  const serialFirst = await resolved(scheduler.acquire({ model: "shared-model" }));
  serialFirst.release();
  const serialSecond = await resolved(scheduler.acquire({ model: "shared-model" }));
  serialSecond.release();
  assert.notEqual(serialFirst.account.id, serialSecond.account.id);
  assert.notEqual(serialFirst.egressId, serialSecond.egressId);

  // A failed egress cools down that account; the next request spills to the
  // other DeepInfra account without changing either account's proxy.
  scheduler.markFailure(direct.id, "egress unavailable");
  const fallback = await resolved(scheduler.acquire({ model: "shared-model" }));
  assert.equal(fallback.account.id, proxy.id);
  fallback.release();
});

test("upstream rate limits cool every account sharing the egress", async () => {
  const sharedA = account("a", ["m1"], "http://first:one@proxy.example:8080");
  const sharedB = account("b", ["m1"], "http://second:two@PROXY.example:8080");
  const { scheduler, clock } = harness([sharedA, sharedB], { proxyRpm: 100, accountRpm: 100 });
  scheduler.markEgressRateLimit(sharedA.proxy, "Too many requests", 12);
  const blocked = scheduler.acquire({ model: "m1" });
  assert.equal(await pending(blocked), true);
  const snapshot = await scheduler.runtimeSnapshot();
  assert.equal(snapshot.egresses[0]?.cooldownUntil, 12_000);
  assert.equal(snapshot.egresses[0]?.lastError, "Too many requests");
  await clock.advance(12_000);
  const recovered = await resolved(blocked);
  assert.ok(["a", "b"].includes(recovered.account.id));
  recovered.release();
});

test("proxy RPM is shared across credentials while different proxies stay independent", async () => {
  const sharedA = account("a", ["m1"], "http://first:one@proxy.example:8080");
  const sharedB = account("b", ["m1"], "http://second:two@PROXY.example:8080");
  assert.equal(egressIdentity(sharedA.proxy).key, egressIdentity(sharedB.proxy).key);
  const shared = harness([sharedA, sharedB], { proxyRpm: 2, accountRpm: 100, accountModelConcurrency: 10 });
  const leases = [
    await resolved(shared.scheduler.acquire({ model: "m1" })),
    await resolved(shared.scheduler.acquire({ model: "m1" })),
  ];
  releaseAll(leases);
  const blocked = shared.scheduler.acquire({ model: "m1" });
  assert.equal(await pending(blocked), true);

  const independent = harness([
    sharedA,
    account("c", ["m1"], "http://other.example:8080"),
  ], { proxyRpm: 1, accountRpm: 100, accountModelConcurrency: 10 });
  const first = await resolved(independent.scheduler.acquire({ model: "m1", preferredAccountId: "a" }));
  first.release();
  const spill = await resolved(independent.scheduler.acquire({ model: "m1", preferredAccountId: "a" }));
  assert.equal(spill.account.id, "c");
  spill.release();
  shared.scheduler.resetForTests();
  await assert.rejects(blocked, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

test("direct egress limiting is optional and shared when enabled", async () => {
  const accounts = [account("a"), account("b")];
  const unlimited = harness(accounts, { directEgressLimitEnabled: false, directEgressRpm: 1, accountRpm: 100 });
  const first = await resolved(unlimited.scheduler.acquire({ model: "m1" }));
  first.release();
  const second = await resolved(unlimited.scheduler.acquire({ model: "m1" }));
  second.release();

  const limited = harness(accounts, { directEgressLimitEnabled: true, directEgressRpm: 1, accountRpm: 100 });
  const limitedFirst = await resolved(limited.scheduler.acquire({ model: "m1" }));
  limitedFirst.release();
  const waiting = limited.scheduler.acquire({ model: "m1" });
  assert.equal(await pending(waiting), true);
  limited.scheduler.resetForTests();
  await assert.rejects(waiting, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

test("model busy cools only that model, not the account", async () => {
  const { scheduler, clock } = harness([account("a", ["m1", "m2"])], {
    accountModelConcurrency: 2,
    accountRpm: 100,
  });
  scheduler.markModelCapacityFailure("a", "m1", "Model busy, retry later", 30);
  const blocked = scheduler.acquire({ model: "m1" });
  assert.equal(await pending(blocked), true);
  const other = await resolved(scheduler.acquire({ model: "m2" }));
  assert.equal(other.account.id, "a");
  other.release();
  await clock.advance(30_000);
  const recovered = await resolved(blocked);
  assert.equal(recovered.account.id, "a");
  recovered.release();
});

test("a success from an earlier admission cannot clear a later failure cooldown", async () => {
  const { scheduler, clock } = harness([account("a", ["m1", "m2"])], {
    accountModelConcurrency: 2,
    accountRpm: 100,
  });
  scheduler.markModelCapacityFailure("a", "m1", "temporary model cooldown", 1);
  const queuedFirst = scheduler.acquire({ model: "m1" });
  assert.equal(await pending(queuedFirst), true);

  // This request was enqueued second but admitted first. Admission ordering,
  // rather than waiter ordering, must decide whether its success is stale.
  const admittedFirst = await resolved(scheduler.acquire({ model: "m2" }));
  await clock.advance(1_000);
  const admittedLater = await resolved(queuedFirst);
  assert.ok(admittedFirst.admissionSequence < admittedLater.admissionSequence);

  scheduler.markFailure("a", "rate limited", 30, admittedLater.admissionSequence);
  scheduler.markSuccess("a", admittedFirst.admissionSequence);
  const state = scheduler.publicState(admittedLater.account).runtime;
  assert.ok(state.cooldownUntil > 0);
  assert.equal(state.lastError, "rate limited");

  scheduler.markModelCapacityFailure("a", "m1", "slots full", 30, admittedLater.admissionSequence);
  scheduler.markSuccess("a");
  const resetState = scheduler.publicState(admittedLater.account).runtime;
  assert.equal(resetState.cooldownUntil, 0);
  assert.deepEqual(resetState.modelCooldownUntil, {});
  admittedFirst.release();
  admittedLater.release();
});

test("leases retain an immutable account and egress snapshot", async () => {
  const source = account("a", ["m1"], "http://old.example:8080");
  const { scheduler } = harness([source], { accountRpm: 100, proxyRpm: 100 });
  const first = await resolved(scheduler.acquire({ model: "m1" }));
  source.proxy = "http://new.example:8080";
  source.models = ["m2"];
  assert.equal(first.account.proxy, "http://old.example:8080");
  assert.deepEqual(first.account.models, ["m1"]);
  first.release();

  const retry = await resolved(scheduler.acquire({ model: "m1", accountSnapshot: first.account }));
  assert.equal(retry.account.proxy, "http://old.example:8080");
  retry.release();
});

test("soft affinity spills from a full account and follows the successful spill", async () => {
  const { scheduler } = harness([account("a"), account("b")], { accountModelConcurrency: 1, accountRpm: 100 });
  const first = await resolved(scheduler.acquire({ model: "m1", stickyKey: "session" }));
  const spill = await resolved(scheduler.acquire({ model: "m1", stickyKey: "session" }));
  assert.notEqual(spill.account.id, first.account.id);
  first.release();
  spill.release();

  const next = await resolved(scheduler.acquire({ model: "m1", stickyKey: "session" }));
  assert.equal(next.account.id, spill.account.id);
  next.release();
});

test("group-scoped admission cannot select accounts outside the group", async () => {
  const grouped = account("grouped");
  grouped.groupIds = ["group-a"];
  const outside = account("outside");
  outside.groupIds = ["group-b"];
  const { scheduler } = harness([outside, grouped], { accountRpm: 100 });

  const lease = await resolved(scheduler.acquire({ model: "m1", groupId: "group-a" }));
  assert.equal(lease.account.id, "grouped");
  lease.release();
  await assert.rejects(
    scheduler.acquire({ model: "m1", groupId: "missing-group" }),
    /No enabled DeepInfra account/,
  );
});

test("abort, timeout, queue size and hot settings updates settle waiters", async () => {
  const abortedHarness = harness([account("a")], { accountModelConcurrency: 1, accountRpm: 100 });
  const active = await resolved(abortedHarness.scheduler.acquire({ model: "m1" }));
  const controller = new AbortController();
  const aborted = abortedHarness.scheduler.acquire({ model: "m1", signal: controller.signal });
  assert.equal(await pending(aborted), true);
  controller.abort();
  await assert.rejects(aborted, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal((await abortedHarness.scheduler.runtimeSnapshot()).pending, 0);
  active.release();

  const timeoutHarness = harness([account("a")], { accountModelConcurrency: 1, accountRpm: 100, queueTimeoutSeconds: 2 });
  const timeoutActive = await resolved(timeoutHarness.scheduler.acquire({ model: "m1" }));
  const timedOut = timeoutHarness.scheduler.acquire({ model: "m1" });
  assert.equal(await pending(timedOut), true);
  await timeoutHarness.clock.advance(2_000);
  await assert.rejects(timedOut, (error: unknown) => error instanceof SchedulerAdmissionError && error.code === "queue_timeout");
  timeoutActive.release();

  const bounded = harness([account("a")], { accountModelConcurrency: 1, accountRpm: 100, maxQueueSize: 1 });
  const boundedActive = await resolved(bounded.scheduler.acquire({ model: "m1" }));
  const queued = bounded.scheduler.acquire({ model: "m1" });
  const overflow = bounded.scheduler.acquire({ model: "m1" });
  await assert.rejects(overflow, (error: unknown) => error instanceof SchedulerAdmissionError && error.code === "queue_full");
  bounded.updateSettings({ accountModelConcurrency: 2 });
  const admitted = await resolved(queued);
  admitted.release();
  boundedActive.release();
});

test("queue admission errors expose Retry-After through the OpenAI error response", async () => {
  const response = openAIErrorResponse(new SchedulerAdmissionError("Queue full.", "queue_full", 7));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal((await response.json()).error.code, "queue_full");
});

test("model cooldown blocks only that account/model and runtime snapshots stay sanitized", async () => {
  const proxy = "http://user:password@proxy.example:8080";
  const { scheduler, clock } = harness([account("a", ["m1", "m2"], proxy)], { accountRpm: 100 });
  scheduler.markModelCapacityFailure("a", "m1", "5/5 slots", 2);
  const blocked = scheduler.acquire({ model: "m1" });
  assert.equal(await pending(blocked), true);
  const other = await resolved(scheduler.acquire({ model: "m2" }));
  other.release();
  const snapshotText = JSON.stringify(await scheduler.runtimeSnapshot());
  assert.equal(snapshotText.includes("user"), false);
  assert.equal(snapshotText.includes("password"), false);
  assert.match(snapshotText, /egress_/);
  await clock.advance(2_000);
  const admitted = await resolved(blocked);
  admitted.release();
});
