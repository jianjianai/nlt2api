import { createHash } from "node:crypto";
import type { ForecastConstraint, SchedulerAnalyticsEvent } from "~/server/utils/analytics-types.ts";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";
import { HttpError } from "~/server/utils/http.ts";
import { egressIdentity, type EgressIdentity } from "~/server/utils/proxy.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import { DEFAULT_SCHEDULER_SETTINGS } from "~/server/utils/types.ts";
import type {
  AccountRuntimeState,
  EgressRuntimeState,
  ManagedAccount,
  ProxySettings,
  PublicAccount,
  SchedulerRuntimeSnapshot,
  SchedulerSettings,
} from "~/server/utils/types.ts";

const RATE_WINDOW_MS = 60_000;
const MAX_STICKY_ASSIGNMENTS = 10_000;

type TimerHandle = ReturnType<typeof setTimeout>;

interface Assignment {
  accountId: string;
  expiresAt: number;
}

interface InternalAccountRuntime {
  modelInFlight: Map<string, number>;
  requestTimes: number[];
  modelCooldownUntil: Map<string, number>;
  lastFailureSequence: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError?: string;
  lastUsedAt?: string;
  lastSuccessAt?: string;
}

interface InternalEgressRuntime {
  identity: EgressIdentity;
  requestTimes: number[];
}

export interface AccountLease {
  /** Immutable account/egress snapshot used for this real portal attempt. */
  account: ManagedAccount;
  model: string;
  egressId: string;
  admittedAt: number;
  admissionSequence: number;
  release(): void;
}

export interface AcquireOptions {
  model: string;
  stickyKey?: string;
  preferredAccountId?: string;
  /** Internal retries retain the first attempt's immutable account/egress. */
  accountSnapshot?: ManagedAccount;
  excludedAccountIds?: ReadonlySet<string>;
  signal?: AbortSignal;
}

export interface AccountSchedulerDependencies {
  listAccounts(): Promise<ManagedAccount[]>;
  getSettings(): Promise<ProxySettings>;
  now(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  emitAnalytics?(event: SchedulerAnalyticsEvent): void;
}

interface Waiter {
  sequence: number;
  enqueuedAt: number;
  options: AcquireOptions;
  resolve: (lease: AccountLease) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
  blockedReported: boolean;
}

interface AdmissionBlocked {
  kind: "blocked";
  nextEligibleAt?: number;
  constraint: ForecastConstraint;
}

interface AdmissionGranted {
  kind: "granted";
  lease: AccountLease;
}

interface AdmissionImpossible {
  kind: "impossible";
  error: Error;
}

type AdmissionResult = AdmissionBlocked | AdmissionGranted | AdmissionImpossible;

const productionDependencies: AccountSchedulerDependencies = {
  listAccounts: () => stateStore.listAccounts(),
  getSettings: () => stateStore.getSettings(),
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle),
  emitAnalytics: (event) => usageAnalytics.recordSchedulerEvent(event),
};

function assignmentKey(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function score(stickyKey: string, account: ManagedAccount): number {
  const digest = createHash("sha256")
    .update(stickyKey + "\u0000" + account.id)
    .digest();
  const value = (digest.readUInt32BE(0) + 1) / 0x1_0000_0001;
  return -Math.log(value) / Math.max(1, account.weight);
}

function abortedError(): DOMException {
  return new DOMException("The request was aborted while waiting for upstream capacity.", "AbortError");
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

export class SchedulerAdmissionError extends HttpError {
  constructor(
    message: string,
    code: "queue_full" | "queue_timeout",
    readonly retryAfterSeconds?: number,
  ) {
    super(429, message, "rate_limit_error", undefined, code);
    this.name = "SchedulerAdmissionError";
  }
}

export class AccountScheduler {
  private readonly runtimeByAccount = new Map<string, InternalAccountRuntime>();
  private readonly runtimeByEgress = new Map<string, InternalEgressRuntime>();
  private readonly stickyAssignments = new Map<string, Assignment>();
  private readonly toolCallAssignments = new Map<string, Assignment>();
  private readonly waiters: Waiter[] = [];
  private sequence = 0;
  private nextAdmissionSequence = 0;
  private draining = false;
  private drainRequested = false;
  private wakeTimer: TimerHandle | undefined;
  private wakeAt: number | undefined;
  private lastSettings: SchedulerSettings = { ...DEFAULT_SCHEDULER_SETTINGS };

  constructor(private readonly dependencies: AccountSchedulerDependencies = productionDependencies) {}

  async acquire(options: AcquireOptions): Promise<AccountLease> {
    if (!options.model) {
      throw new Error("A model is required for scheduler admission.");
    }
    if (options.signal?.aborted) {
      throw abortedError();
    }
    const settings = (await this.dependencies.getSettings()).scheduler;
    this.lastSettings = settings;

    const sequence = this.sequence++;
    const enqueuedAt = this.dependencies.now();
    return new Promise<AccountLease>((resolve, reject) => {
      const waiter: Waiter = {
        sequence,
        enqueuedAt,
        options: { ...options, excludedAccountIds: new Set(options.excludedAccountIds ?? []) },
        resolve,
        reject,
        blockedReported: false,
      };
      if (options.signal) {
        waiter.abort = () => {
          if (!this.removeWaiter(waiter)) return;
          reject(abortedError());
          this.requestDrain();
        };
        options.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
      this.waiters.sort((left, right) => left.sequence - right.sequence);
      this.requestDrain();
    });
  }

  markSuccess(accountId: string, admissionSequence?: number): void {
    const runtime = this.runtimeFor(accountId);
    runtime.lastSuccessAt = new Date(this.dependencies.now()).toISOString();
    // Administrator verification has no sequence and deliberately resets the
    // account. A completed request may clear only failures no newer than its
    // own admission, so an old success cannot erase a later 429 cooldown.
    if (admissionSequence !== undefined && admissionSequence < runtime.lastFailureSequence) {
      return;
    }
    runtime.consecutiveFailures = 0;
    runtime.cooldownUntil = 0;
    runtime.lastError = undefined;
    if (admissionSequence === undefined) {
      runtime.lastFailureSequence = -1;
      runtime.modelCooldownUntil.clear();
    }
    this.requestDrain();
  }

  markFailure(accountId: string, message: string, retryAfterSeconds?: number, admissionSequence?: number): void {
    const runtime = this.runtimeFor(accountId);
    if (admissionSequence !== undefined) {
      runtime.lastFailureSequence = Math.max(runtime.lastFailureSequence, admissionSequence);
    }
    runtime.consecutiveFailures += 1;
    runtime.lastError = message.slice(0, 300);
    const exponentialBackoffMs = Math.min(120_000, 1_000 * (2 ** Math.min(runtime.consecutiveFailures, 7)));
    const retryAfterMs = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 0;
    runtime.cooldownUntil = Math.max(
      runtime.cooldownUntil,
      this.dependencies.now() + Math.max(exponentialBackoffMs, retryAfterMs),
    );
    this.requestDrain();
  }

  markModelCapacityFailure(
    accountId: string,
    model: string,
    message: string,
    retryAfterSeconds = 1,
    admissionSequence?: number,
  ): void {
    const runtime = this.runtimeFor(accountId);
    if (admissionSequence !== undefined) {
      runtime.lastFailureSequence = Math.max(runtime.lastFailureSequence, admissionSequence);
    }
    runtime.lastError = message.slice(0, 300);
    runtime.modelCooldownUntil.set(
      model,
      Math.max(
        runtime.modelCooldownUntil.get(model) ?? 0,
        this.dependencies.now() + Math.max(1, retryAfterSeconds) * 1_000,
      ),
    );
    this.requestDrain();
  }

  invalidateStickyAccount(accountId: string): void {
    this.removeAssignmentsFor(accountId, this.stickyAssignments);
    this.removeAssignmentsFor(accountId, this.toolCallAssignments);
    this.requestDrain();
  }

  bindStickyKey(accountId: string, stickyKey: string): void {
    if (!stickyKey) return;
    this.rememberAssignment(
      this.stickyAssignments,
      assignmentKey(stickyKey),
      accountId,
      this.lastSettings.stickyTtlSeconds * 1_000,
    );
  }

  bindToolCalls(accountId: string, callIds: string[]): void {
    const ttlMs = this.lastSettings.stickyTtlSeconds * 1_000;
    for (const callId of callIds) {
      this.rememberAssignment(this.toolCallAssignments, assignmentKey(callId), accountId, ttlMs);
    }
  }

  accountForToolCalls(callIds: string[]): string | undefined {
    this.pruneAssignments(this.dependencies.now());
    const assignments = callIds
      .map((callId) => this.toolCallAssignments.get(assignmentKey(callId))?.accountId)
      .filter((accountId): accountId is string => Boolean(accountId));
    if (assignments.length !== callIds.length || assignments.length === 0) {
      return undefined;
    }
    return assignments.every((accountId) => accountId === assignments[0]) ? assignments[0] : undefined;
  }

  publicState(account: ManagedAccount): PublicAccount {
    const now = this.dependencies.now();
    const runtime = this.runtimeFor(account.id);
    this.pruneTimes(runtime.requestTimes, now);
    this.pruneModelCooldowns(runtime, now);
    const accountRpm = account.schedulerOverrides?.accountRpm ?? this.lastSettings.accountRpm;
    return {
      id: account.id,
      label: account.label,
      email: account.email,
      password: account.password,
      enabled: account.enabled,
      weight: account.weight,
      proxy: account.proxy ?? null,
      ...(account.proxyPoolEntryId ? { proxyPoolEntryId: account.proxyPoolEntryId } : {}),
      models: [...account.models],
      ...(account.schedulerOverrides ? { schedulerOverrides: structuredClone(account.schedulerOverrides) } : {}),
      hasSession: Boolean(account.session),
      sessionExpiresAt: account.session?.expiresAt ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      runtime: this.publicRuntime(runtime, accountRpm, now),
    };
  }

  async runtimeSnapshot(): Promise<SchedulerRuntimeSnapshot> {
    const [accounts, stored] = await Promise.all([
      this.dependencies.listAccounts(),
      this.dependencies.getSettings(),
    ]);
    const now = this.dependencies.now();
    const settings = stored.scheduler;
    this.lastSettings = settings;
    const accountCount = new Map<string, { identity: EgressIdentity; count: number }>();
    for (const account of accounts) {
      const identity = egressIdentity(account.proxy);
      const group = accountCount.get(identity.key) ?? { identity, count: 0 };
      group.count += 1;
      accountCount.set(identity.key, group);
    }
    const egresses: EgressRuntimeState[] = [...accountCount.values()].map(({ identity, count }) => {
      const runtime = this.egressRuntime(identity);
      this.pruneTimes(runtime.requestTimes, now);
      const limited = !identity.direct || settings.directEgressLimitEnabled;
      const rpm = identity.direct ? settings.directEgressRpm : settings.proxyRpm;
      return {
        id: identity.id,
        accountCount: count,
        requestsLastMinute: runtime.requestTimes.length,
        ...(limited && runtime.requestTimes.length >= rpm
          ? { nextRateAvailableAt: this.rateAvailableAt(runtime.requestTimes, rpm) }
          : {}),
        limited,
        rpm,
      };
    }).sort((left, right) => left.id.localeCompare(right.id));
    const oldest = this.waiters[0];
    return {
      pending: this.waiters.length,
      oldestWaitMs: oldest ? Math.max(0, now - oldest.enqueuedAt) : 0,
      egresses,
    };
  }

  notifyStateChanged(): void {
    this.requestDrain();
  }

  remove(accountId: string): void {
    this.runtimeByAccount.delete(accountId);
    this.invalidateStickyAccount(accountId);
  }

  resetForTests(): void {
    this.runtimeByAccount.clear();
    this.runtimeByEgress.clear();
    this.stickyAssignments.clear();
    this.toolCallAssignments.clear();
    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter, () => waiter.reject(abortedError()));
    }
    this.clearWakeTimer();
    this.sequence = 0;
    this.nextAdmissionSequence = 0;
    this.lastSettings = { ...DEFAULT_SCHEDULER_SETTINGS };
  }

  private requestDrain(): void {
    this.drainRequested = true;
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      void this.drainLoop().catch((error) => {
        for (const waiter of [...this.waiters]) {
          this.settleWaiter(waiter, () => waiter.reject(error));
        }
      }).finally(() => {
        this.draining = false;
        if (this.drainRequested) this.requestDrain();
      });
    });
  }

  private async drainLoop(): Promise<void> {
    while (this.drainRequested) {
      this.drainRequested = false;
      await this.drainOnce();
    }
  }

  private async drainOnce(): Promise<void> {
    if (this.waiters.length === 0) {
      this.clearWakeTimer();
      return;
    }
    const [accounts, stored] = await Promise.all([
      this.dependencies.listAccounts(),
      this.dependencies.getSettings(),
    ]);
    const settings = stored.scheduler;
    this.lastSettings = settings;
    let progress = true;
    let earliestWake: number | undefined;

    while (progress) {
      progress = false;
      for (const waiter of [...this.waiters]) {
        const now = this.dependencies.now();
        if (waiter.options.signal?.aborted) {
          this.settleWaiter(waiter, () => waiter.reject(abortedError()));
          progress = true;
          continue;
        }
        if (settings.queueTimeoutSeconds > 0) {
          const timeoutAt = waiter.enqueuedAt + settings.queueTimeoutSeconds * 1_000;
          if (timeoutAt <= now) {
            this.emitAnalytics({
              type: "rejected",
              at: now,
              model: waiter.options.model,
              waitMs: Math.max(0, now - waiter.enqueuedAt),
              constraint: "queue_policy",
            });
            this.settleWaiter(waiter, () => waiter.reject(new SchedulerAdmissionError(
              "Timed out while waiting for upstream capacity.",
              "queue_timeout",
              this.retryAfterSeconds(),
            )));
            progress = true;
            continue;
          }
          earliestWake = minDefined(earliestWake, timeoutAt);
        }

        const result = this.tryAdmit(waiter, accounts, settings, now);
        if (result.kind === "granted") {
          this.emitAnalytics({
            type: "admitted",
            at: now,
            model: waiter.options.model,
            accountId: result.lease.account.id,
            egressId: result.lease.egressId,
            waitMs: Math.max(0, now - waiter.enqueuedAt),
          });
          this.settleWaiter(waiter, () => waiter.resolve(result.lease));
          progress = true;
        } else if (result.kind === "impossible") {
          this.emitAnalytics({
            type: "rejected",
            at: now,
            model: waiter.options.model,
            waitMs: Math.max(0, now - waiter.enqueuedAt),
            constraint: "no_healthy_account",
          });
          this.settleWaiter(waiter, () => waiter.reject(result.error));
          progress = true;
        } else {
          if (!waiter.blockedReported) {
            waiter.blockedReported = true;
            this.emitAnalytics({
              type: "blocked",
              at: now,
              model: waiter.options.model,
              waitMs: Math.max(0, now - waiter.enqueuedAt),
              constraint: result.constraint,
            });
          }
          earliestWake = minDefined(earliestWake, result.nextEligibleAt);
        }
      }
    }

    if (settings.maxQueueSize > 0 && this.waiters.length > settings.maxQueueSize) {
      const overflow = this.waiters.slice(settings.maxQueueSize);
      for (const waiter of overflow) {
        this.emitAnalytics({
          type: "rejected",
          at: this.dependencies.now(),
          model: waiter.options.model,
          waitMs: Math.max(0, this.dependencies.now() - waiter.enqueuedAt),
          constraint: "queue_policy",
        });
        this.settleWaiter(waiter, () => waiter.reject(new SchedulerAdmissionError(
          "The upstream capacity queue is full.",
          "queue_full",
          earliestWake === undefined ? undefined : Math.max(1, Math.ceil((earliestWake - this.dependencies.now()) / 1_000)),
        )));
      }
    }

    if (this.waiters.length === 0) {
      this.clearWakeTimer();
    } else if (earliestWake !== undefined) {
      this.scheduleWake(earliestWake);
    } else {
      this.clearWakeTimer();
    }
  }

  private tryAdmit(waiter: Waiter, allAccounts: ManagedAccount[], settings: SchedulerSettings, now: number): AdmissionResult {
    this.pruneAssignments(now);
    const excluded = waiter.options.excludedAccountIds ?? new Set<string>();
    const sourceAccounts = waiter.options.accountSnapshot ? [waiter.options.accountSnapshot] : allAccounts;
    const accounts = sourceAccounts
      .filter((account) => account.enabled)
      .filter((account) => account.models.includes(waiter.options.model))
      .filter((account) => !excluded.has(account.id));
    if (accounts.length === 0) {
      return { kind: "impossible", error: new Error("No enabled NeuralWatt account is currently available.") };
    }

    const stickyHash = waiter.options.stickyKey ? assignmentKey(waiter.options.stickyKey) : undefined;
    const stickyAccountId = stickyHash ? this.stickyAssignments.get(stickyHash)?.accountId : undefined;
    const preferred = [waiter.options.preferredAccountId, stickyAccountId].filter((value): value is string => Boolean(value));
    const preferredSet = new Set(preferred);
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const ranked: ManagedAccount[] = [];
    for (const accountId of preferred) {
      const account = byId.get(accountId);
      if (account && !ranked.some((candidate) => candidate.id === account.id)) ranked.push(account);
    }
    const remaining = accounts.filter((account) => !preferredSet.has(account.id));
    remaining.sort((left, right) => {
      if (stickyHash) {
        const difference = score(stickyHash, left) - score(stickyHash, right);
        if (difference !== 0) return difference;
      }
      const difference = this.effectiveLoad(left) - this.effectiveLoad(right);
      return difference !== 0 ? difference : left.createdAt.localeCompare(right.createdAt);
    });
    ranked.push(...remaining);

    let nextEligibleAt: number | undefined;
    const constraints = new Set<ForecastConstraint>();
    for (const account of ranked) {
      const runtime = this.runtimeFor(account.id);
      this.pruneTimes(runtime.requestTimes, now);
      this.pruneModelCooldowns(runtime, now);
      if (runtime.cooldownUntil > now) {
        constraints.add("account_cooldown");
        nextEligibleAt = minDefined(nextEligibleAt, runtime.cooldownUntil);
        continue;
      }
      const modelCooldown = runtime.modelCooldownUntil.get(waiter.options.model) ?? 0;
      if (modelCooldown > now) {
        constraints.add("model_cooldown");
        nextEligibleAt = minDefined(nextEligibleAt, modelCooldown);
        continue;
      }
      const concurrency = account.schedulerOverrides?.modelConcurrency?.[waiter.options.model]
        ?? account.schedulerOverrides?.accountModelConcurrency
        ?? settings.accountModelConcurrency;
      if ((runtime.modelInFlight.get(waiter.options.model) ?? 0) >= concurrency) {
        constraints.add("model_concurrency");
        continue;
      }
      const accountRpm = account.schedulerOverrides?.accountRpm ?? settings.accountRpm;
      if (runtime.requestTimes.length >= accountRpm) {
        constraints.add("account_rpm");
        nextEligibleAt = minDefined(nextEligibleAt, this.rateAvailableAt(runtime.requestTimes, accountRpm));
        continue;
      }
      const identity = egressIdentity(account.proxy);
      const egress = this.egressRuntime(identity);
      this.pruneTimes(egress.requestTimes, now);
      const egressLimited = !identity.direct || settings.directEgressLimitEnabled;
      const egressRpm = identity.direct ? settings.directEgressRpm : settings.proxyRpm;
      if (egressLimited && egress.requestTimes.length >= egressRpm) {
        constraints.add("shared_egress_rpm");
        nextEligibleAt = minDefined(nextEligibleAt, this.rateAvailableAt(egress.requestTimes, egressRpm));
        continue;
      }

      runtime.modelInFlight.set(waiter.options.model, (runtime.modelInFlight.get(waiter.options.model) ?? 0) + 1);
      runtime.requestTimes.push(now);
      runtime.lastUsedAt = new Date(now).toISOString();
      egress.requestTimes.push(now);
      if (stickyHash) {
        this.rememberAssignment(this.stickyAssignments, stickyHash, account.id, settings.stickyTtlSeconds * 1_000);
      }
      const accountSnapshot = structuredClone(account);
      return {
        kind: "granted",
        lease: this.lease(accountSnapshot, waiter.options.model, this.nextAdmissionSequence++),
      };
    }
    const constraint = [
      "shared_egress_rpm",
      "account_rpm",
      "model_concurrency",
      "model_cooldown",
      "account_cooldown",
    ].find((value) => constraints.has(value as ForecastConstraint)) as ForecastConstraint | undefined;
    return { kind: "blocked", nextEligibleAt, constraint: constraint ?? "no_healthy_account" };
  }

  private lease(account: ManagedAccount, model: string, admissionSequence: number): AccountLease {
    let released = false;
    const admittedAt = this.dependencies.now();
    const egressId = egressIdentity(account.proxy).id;
    return {
      account,
      model,
      egressId,
      admittedAt,
      admissionSequence,
      release: () => {
        if (released) return;
        released = true;
        this.emitAnalytics({
          type: "released",
          at: this.dependencies.now(),
          model,
          accountId: account.id,
          egressId,
          durationMs: Math.max(0, this.dependencies.now() - admittedAt),
        });
        const runtime = this.runtimeFor(account.id);
        const count = runtime.modelInFlight.get(model) ?? 0;
        if (count <= 1) runtime.modelInFlight.delete(model);
        else runtime.modelInFlight.set(model, count - 1);
        this.requestDrain();
      },
    };
  }

  private emitAnalytics(event: SchedulerAnalyticsEvent): void {
    try {
      this.dependencies.emitAnalytics?.(event);
    } catch {
      // Capacity observation must never affect scheduler admission.
    }
  }

  private runtimeFor(accountId: string): InternalAccountRuntime {
    const existing = this.runtimeByAccount.get(accountId);
    if (existing) return existing;
    const created: InternalAccountRuntime = {
      modelInFlight: new Map(),
      requestTimes: [],
      modelCooldownUntil: new Map(),
      lastFailureSequence: -1,
      consecutiveFailures: 0,
      cooldownUntil: 0,
    };
    this.runtimeByAccount.set(accountId, created);
    return created;
  }

  private egressRuntime(identity: EgressIdentity): InternalEgressRuntime {
    const existing = this.runtimeByEgress.get(identity.key);
    if (existing) return existing;
    const created = { identity, requestTimes: [] };
    this.runtimeByEgress.set(identity.key, created);
    return created;
  }

  private publicRuntime(runtime: InternalAccountRuntime, accountRpm: number, now: number): AccountRuntimeState {
    const modelInFlight = Object.fromEntries([...runtime.modelInFlight].filter(([, count]) => count > 0));
    const modelCooldownUntil = Object.fromEntries([...runtime.modelCooldownUntil].filter(([, until]) => until > now));
    const inFlight = Object.values(modelInFlight).reduce((total, count) => total + count, 0);
    return {
      inFlight,
      modelInFlight,
      requestsLastMinute: runtime.requestTimes.length,
      ...(runtime.requestTimes.length >= accountRpm
        ? { nextRateAvailableAt: this.rateAvailableAt(runtime.requestTimes, accountRpm) }
        : {}),
      modelCooldownUntil,
      consecutiveFailures: runtime.consecutiveFailures,
      cooldownUntil: runtime.cooldownUntil,
      ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
      ...(runtime.lastUsedAt ? { lastUsedAt: runtime.lastUsedAt } : {}),
      ...(runtime.lastSuccessAt ? { lastSuccessAt: runtime.lastSuccessAt } : {}),
    };
  }

  private effectiveLoad(account: ManagedAccount): number {
    const inFlight = [...this.runtimeFor(account.id).modelInFlight.values()].reduce((total, count) => total + count, 0);
    return inFlight / Math.max(1, account.weight);
  }

  private pruneTimes(times: number[], now: number): void {
    let index = 0;
    while (index < times.length && times[index]! <= now - RATE_WINDOW_MS) index += 1;
    if (index > 0) times.splice(0, index);
  }

  private rateAvailableAt(times: number[], limit: number): number | undefined {
    if (times.length < limit) return undefined;
    return times[times.length - limit]! + RATE_WINDOW_MS;
  }

  private pruneModelCooldowns(runtime: InternalAccountRuntime, now: number): void {
    for (const [model, until] of runtime.modelCooldownUntil) {
      if (until <= now) runtime.modelCooldownUntil.delete(model);
    }
  }

  private rememberAssignment(target: Map<string, Assignment>, key: string, accountId: string, ttlMs: number): void {
    if (!key) return;
    this.pruneAssignments(this.dependencies.now());
    target.delete(key);
    target.set(key, { accountId, expiresAt: this.dependencies.now() + ttlMs });
    while (target.size > MAX_STICKY_ASSIGNMENTS) {
      const first = target.keys().next().value as string | undefined;
      if (first === undefined) break;
      target.delete(first);
    }
  }

  private pruneAssignments(now: number): void {
    for (const target of [this.stickyAssignments, this.toolCallAssignments]) {
      for (const [key, assignment] of target) {
        if (assignment.expiresAt <= now) target.delete(key);
      }
    }
  }

  private removeAssignmentsFor(accountId: string, target: Map<string, Assignment>): void {
    for (const [key, assignment] of target) {
      if (assignment.accountId === accountId) target.delete(key);
    }
  }

  private removeWaiter(waiter: Waiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return false;
    this.waiters.splice(index, 1);
    if (waiter.abort && waiter.options.signal) {
      waiter.options.signal.removeEventListener("abort", waiter.abort);
    }
    return true;
  }

  private settleWaiter(waiter: Waiter, settle: () => void): void {
    if (!this.removeWaiter(waiter)) return;
    settle();
  }

  private retryAfterSeconds(): number | undefined {
    if (this.wakeAt === undefined) return undefined;
    return Math.max(1, Math.ceil((this.wakeAt - this.dependencies.now()) / 1_000));
  }

  private scheduleWake(at: number): void {
    if (this.wakeAt === at && this.wakeTimer !== undefined) return;
    this.clearWakeTimer();
    this.wakeAt = at;
    this.wakeTimer = this.dependencies.setTimer(() => {
      this.wakeTimer = undefined;
      this.wakeAt = undefined;
      this.requestDrain();
    }, Math.max(0, at - this.dependencies.now()));
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer !== undefined) this.dependencies.clearTimer(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeAt = undefined;
  }
}

export const accountScheduler = new AccountScheduler();
