import { createHash } from "node:crypto";
import { maskProxyUrl } from "~/server/utils/proxy.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import type { AccountRuntimeState, ManagedAccount, PublicAccount } from "~/server/utils/types.ts";

const runtimeByAccount = new Map<string, AccountRuntimeState>();
const stickyAssignments = new Map<string, { accountId: string; expiresAt: number }>();
const toolCallAssignments = new Map<string, { accountId: string; expiresAt: number }>();
const STICKY_TTL_MS = 30 * 60 * 1_000;
const MAX_STICKY_ASSIGNMENTS = 10_000;

function runtimeFor(accountId: string): AccountRuntimeState {
  const existing = runtimeByAccount.get(accountId);
  if (existing) {
    return existing;
  }

  const created: AccountRuntimeState = {
    inFlight: 0,
    consecutiveFailures: 0,
    cooldownUntil: 0,
  };
  runtimeByAccount.set(accountId, created);
  return created;
}

function score(stickyKey: string, account: ManagedAccount): number {
  const digest = createHash("sha256")
    .update(`${stickyKey}\u0000${account.id}`)
    .digest();
  const value = (digest.readUInt32BE(0) + 1) / 0x1_0000_0001;
  // Exponential-race HRW scoring gives weights a stable, measurable meaning.
  return -Math.log(value) / Math.max(1, account.weight);
}

function assignmentKey(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function pruneAssignments(): void {
  const now = Date.now();
  for (const [key, assignment] of stickyAssignments) {
    if (assignment.expiresAt <= now) {
      stickyAssignments.delete(key);
    }
  }
  for (const [key, assignment] of toolCallAssignments) {
    if (assignment.expiresAt <= now) {
      toolCallAssignments.delete(key);
    }
  }
  while (stickyAssignments.size > MAX_STICKY_ASSIGNMENTS) {
    const first = stickyAssignments.keys().next().value as string | undefined;
    if (first === undefined) break;
    stickyAssignments.delete(first);
  }
  while (toolCallAssignments.size > MAX_STICKY_ASSIGNMENTS) {
    const first = toolCallAssignments.keys().next().value as string | undefined;
    if (first === undefined) break;
    toolCallAssignments.delete(first);
  }
}

function rememberAssignment(target: Map<string, { accountId: string; expiresAt: number }>, key: string, accountId: string): void {
  if (!key) return;
  pruneAssignments();
  target.delete(key);
  target.set(key, { accountId, expiresAt: Date.now() + STICKY_TTL_MS });
  while (target.size > MAX_STICKY_ASSIGNMENTS) {
    const first = target.keys().next().value as string | undefined;
    if (first === undefined) break;
    target.delete(first);
  }
}

function isAvailable(account: ManagedAccount, now: number): boolean {
  const runtime = runtimeFor(account.id);
  return account.enabled && runtime.cooldownUntil <= now;
}

export class AccountScheduler {
  async acquire(stickyKey?: string, excludedAccountIds = new Set<string>()): Promise<ManagedAccount> {
    pruneAssignments();
    const now = Date.now();
    const accounts = (await stateStore.listAccounts())
      .filter((account) => !excludedAccountIds.has(account.id))
      .filter((account) => isAvailable(account, now));

    if (accounts.length === 0) {
      throw new Error("No enabled NeuralWatt account is currently available.");
    }

    let selected: ManagedAccount | undefined;
    const boundedStickyKey = stickyKey ? assignmentKey(stickyKey) : undefined;
    if (boundedStickyKey) {
      const existing = stickyAssignments.get(boundedStickyKey);
      if (existing && existing.expiresAt > now) {
        selected = accounts.find((account) => account.id === existing.accountId);
        if (selected) {
          rememberAssignment(stickyAssignments, boundedStickyKey, selected.id);
        }
      }

      if (!selected) {
        // Rendezvous score keeps a key stable when the account set changes.
        selected = [...accounts].sort((left, right) => {
          const scoreDifference = score(boundedStickyKey, left) - score(boundedStickyKey, right);
          if (scoreDifference !== 0) {
            return scoreDifference;
          }
          return effectiveLoad(left) - effectiveLoad(right);
        })[0];
        rememberAssignment(stickyAssignments, boundedStickyKey, selected.id);
      }
    }

    selected ??= [...accounts].sort((left, right) => {
      const loadDifference = effectiveLoad(left) - effectiveLoad(right);
      if (loadDifference !== 0) {
        return loadDifference;
      }
      return left.createdAt.localeCompare(right.createdAt);
    })[0];

    const runtime = runtimeFor(selected.id);
    runtime.inFlight += 1;
    runtime.lastUsedAt = new Date().toISOString();
    return selected;
  }

  release(accountId: string): void {
    const runtime = runtimeFor(accountId);
    runtime.inFlight = Math.max(0, runtime.inFlight - 1);
  }

  markSuccess(accountId: string): void {
    const runtime = runtimeFor(accountId);
    runtime.consecutiveFailures = 0;
    runtime.cooldownUntil = 0;
    runtime.lastError = undefined;
    runtime.lastSuccessAt = new Date().toISOString();
  }

  markFailure(accountId: string, message: string, retryAfterSeconds?: number): void {
    const runtime = runtimeFor(accountId);
    runtime.consecutiveFailures += 1;
    runtime.lastError = message.slice(0, 300);
    const exponentialBackoffMs = Math.min(120_000, 1_000 * (2 ** Math.min(runtime.consecutiveFailures, 7)));
    const retryAfterMs = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 0;
    runtime.cooldownUntil = Date.now() + Math.max(exponentialBackoffMs, retryAfterMs);
  }

  invalidateStickyAccount(accountId: string): void {
    for (const [key, assignment] of stickyAssignments) {
      if (assignment.accountId === accountId) {
        stickyAssignments.delete(key);
      }
    }
    for (const [key, assignment] of toolCallAssignments) {
      if (assignment.accountId === accountId) {
        toolCallAssignments.delete(key);
      }
    }
  }

  bindToolCalls(accountId: string, callIds: string[]): void {
    for (const callId of callIds) {
      rememberAssignment(toolCallAssignments, assignmentKey(callId), accountId);
    }
  }

  accountForToolCalls(callIds: string[]): string | undefined {
    pruneAssignments();
    const assignments = callIds
      .map((callId) => toolCallAssignments.get(assignmentKey(callId))?.accountId)
      .filter((accountId): accountId is string => Boolean(accountId));
    if (assignments.length !== callIds.length || assignments.length === 0) {
      return undefined;
    }
    return assignments.every((accountId) => accountId === assignments[0]) ? assignments[0] : undefined;
  }

  publicState(account: ManagedAccount): PublicAccount {
    const runtime = runtimeFor(account.id);
    return {
      id: account.id,
      label: account.label,
      emailHint: maskEmail(account.email),
      enabled: account.enabled,
      weight: account.weight,
      proxyHint: account.proxy ? maskProxyUrl(account.proxy) : null,
      hasSession: Boolean(account.session),
      sessionExpiresAt: account.session?.expiresAt ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      runtime: { ...runtime },
    };
  }

  remove(accountId: string): void {
    runtimeByAccount.delete(accountId);
    this.invalidateStickyAccount(accountId);
  }
}

function effectiveLoad(account: ManagedAccount): number {
  return runtimeFor(account.id).inFlight / Math.max(1, account.weight);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) {
    return "***";
  }
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export const accountScheduler = new AccountScheduler();
