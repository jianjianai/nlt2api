# Configurable Admission Queue and Sticky Account Routing

## Status

Approved design awaiting implementation-plan approval.

## Objective

Replace reactive account failover with a configurable admission queue that prevents ordinary traffic bursts from exceeding known upstream limits.

The scheduler must enforce, before every real portal request:

- Per-account, per-model concurrency. Default: 5.
- Per-account rolling 60-second request rate. Default: 20 RPM.
- Per-egress rolling 60-second request rate. Default: 30 RPM for configured proxies.
- Optional shared rate limiting for the server's direct egress. Default: disabled; configured RPM default: 30.
- Soft session affinity: prefer the assigned account, but spill to another eligible account when the preferred account is temporarily capacity-limited.

All limits, queue controls, affinity lifetime, and supported overrides must be editable in the admin panel. Runtime queue and rate state remains in memory; only configuration is persisted.

## Verified Current Behavior

`server/utils/account-scheduler.ts` currently owns account selection. It filters enabled, non-cooling accounts by model, applies weighted rendezvous hashing for sticky keys, and otherwise selects the lowest effective account load. Its only capacity state is an account-wide `inFlight` counter. It has no concurrency ceiling, rolling request windows, proxy grouping, or wait queue.

`server/utils/chat-service.ts` calls the scheduler before each portal attempt and releases the account in `finally`. Repairs, thinking continuations, and account failover cause additional real portal calls. This is the correct admission boundary: each such call must independently obtain capacity.

Current affinity consists of:

- Explicit `body.user`, `x-sticky-session-id`, or `x-openai-session-id` values.
- A compatibility fallback derived from the first user message.
- Tool-call IDs bound to the account that produced them.
- A 30-minute in-memory affinity lifetime.

Required-account routing for repairs and tool-call turns is already a preference rather than a hard lock. The new scheduler preserves that behavior.

## Production Evidence

A read-only analysis of the latest 500 production debug-record summaries on XIGONG2 covered `2026-08-22T15:44:23.676Z` through `2026-08-22T16:30:46.406Z`.

- 464 of 500 requests targeted `kimi-k3`.
- Client outcomes: 150 status 200, 98 status 429, 249 status 503, and 3 status 400.
- All 249 status 503 records reported that no NeuralWatt account was available.
- All 98 status 429 records reported that the selected portal account was rate limited.
- 150 upstream attempts reported `Concurrent limit reached for moonshotai/Kimi-K3: 5/5 slots in use`.
- Peak client traffic reached 102 requests in one minute.
- The three production accounts currently use three different configured proxy groups.

The `5/5` evidence establishes that concurrency is scoped to account plus model, not merely account. The current production sample proves account-side rate limiting, but does not prove shared-proxy exhaustion because the accounts use distinct proxies. Proxy grouping is nevertheless required for the known per-egress contract and future shared-proxy configurations.

## Ownership and Interfaces

### Scheduler ownership

`server/utils/account-scheduler.ts` remains the sole owner of:

- Eligible-account selection.
- Capacity checks and atomic capacity reservation.
- Waiter ordering, wake-up scheduling, and cancellation.
- Account/model in-flight counters.
- Account and egress rolling request windows.
- Sticky and tool-call account assignments.
- Scheduler runtime snapshots exposed to the admin API.

The request layer supplies model, affinity key, excluded accounts, preferred account, and `AbortSignal`. It must not implement a second limiter or queue.

### Lease API

Replace the account-only acquisition result with a lease concept:

```ts
interface AccountLease {
  account: ManagedAccount;
  release(): void;
}

interface AcquireOptions {
  model: string;
  stickyKey?: string;
  preferredAccountId?: string;
  excludedAccountIds?: ReadonlySet<string>;
  signal?: AbortSignal;
}
```

A lease atomically reserves all applicable capacity. `release()` is idempotent and releases only the account/model concurrency slot. RPM timestamps are retained because the upstream request already consumed rate capacity.

`chat-service.ts` must acquire immediately before `portalClient.requestChat()` and release in `finally`. Every repair, continuation, and failover attempt goes through the same API.

## Persistent Configuration

Extend the existing `ProxySettings -> StateStore -> PATCH /api/admin/settings -> App.vue` path. Do not add a second configuration store.

```ts
interface SchedulerSettings {
  accountModelConcurrency: number; // default 5
  accountRpm: number; // default 20
  proxyRpm: number; // default 30
  directEgressLimitEnabled: boolean; // default false
  directEgressRpm: number; // default 30
  stickyTtlSeconds: number; // default 1800
  queueTimeoutSeconds: number; // 0 means no timeout; default 0
  maxQueueSize: number; // 0 means unlimited; default 0
}

interface AccountSchedulerOverrides {
  accountRpm?: number;
  accountModelConcurrency?: number;
  modelConcurrency?: Record<string, number>;
}
```

`ProxySettings` contains `scheduler: SchedulerSettings`. `ManagedAccount` contains optional `schedulerOverrides`. Existing stores are normalized on read so missing fields receive the defaults without a schema-version break.

Effective limits use this precedence:

- Model concurrency: account model override, then account concurrency override, then global concurrency.
- Account RPM: account RPM override, then global account RPM.
- Proxy and direct-egress RPM: global egress settings only, because an egress limit belongs to the shared egress rather than one account.

All numeric values are positive integers except `queueTimeoutSeconds` and `maxQueueSize`, where zero disables that bound. API validation uses finite upper bounds to reject accidental or abusive values. Model override keys must refer to models currently supported by the account; removing a model also removes its stale override.

## Egress Identity

Configured proxy groups are keyed by normalized protocol, lowercase hostname, and effective port. Credentials and paths are excluded from the identity and never exposed in runtime status. Consequently, accounts using the same proxy endpoint with different credentials share one rate window.

Accounts without a proxy use one direct-egress identity. That identity is ignored when direct-egress limiting is disabled and shares the configured direct-egress RPM when enabled.

The admin API exposes only a stable, non-reversible display identifier for each egress group, its account count, current rolling request count, and next eligible time.

## Admission Algorithm

The scheduler uses one event-driven, in-memory admission queue. Admission is decided in one synchronous state transition so no request can partially reserve one limit while waiting on another.

For each acquisition request:

1. Load enabled accounts that support the requested model and are not explicitly excluded.
2. If no enabled account supports the model, fail immediately with the existing `503 no_account_available` behavior.
3. Rank candidates with the preferred or sticky account first, then weighted rendezvous/load ordering for the remaining accounts.
4. For each candidate, atomically check:
   - Account/model in-flight count below the effective concurrency limit.
   - Account rolling request count below the effective account RPM.
   - Applicable proxy or direct-egress rolling request count below its RPM.
   - Account cooldown expired.
5. On the first admissible candidate, increment account/model in-flight state and append timestamps to account and egress rolling windows. Refresh affinity only after this reservation succeeds.
6. If candidates exist but none is currently admissible, enqueue the request unless a configured queue bound rejects it.

Rolling windows retain timestamps in `(now - 60 seconds, now]` and prune older entries before every decision and runtime snapshot.

Waiters are ordered by arrival, but the scheduler selects the oldest waiter that is currently executable. A blocked request for one model or egress must not cause global head-of-line blocking when another waiter can run.

The scheduler reevaluates waiters when:

- A lease releases a concurrency slot.
- The earliest retained RPM timestamp expires.
- The earliest relevant account cooldown expires.
- An account is enabled, disabled, removed, or changes models/proxy.
- Scheduler configuration changes.
- A waiter is aborted or times out.

Only one timer is maintained for the earliest future eligibility event. The scheduler does not poll.

## Queue Policies

The admin panel provides both optional bounds independently:

- Maximum wait time. Zero means unlimited; a positive value returns `429 queue_timeout` after that many seconds.
- Maximum queue size. Zero means unlimited; a positive value returns `429 queue_full` when the pending count has reached the limit.

The defaults are unlimited wait and unlimited size. Client abort immediately removes the waiter, clears its listeners, and consumes no concurrency or RPM capacity.

A queue timeout or full response includes `Retry-After` when the scheduler can calculate a meaningful next eligibility delay.

## Sticky Routing

Affinity is soft:

- An eligible assigned account with available capacity is selected first.
- A capacity-limited assigned account does not force waiting when another eligible account can admit the request.
- Successful spillover updates the affinity assignment to the selected account.
- Failed candidates do not rewrite affinity.
- Disabled, deleted, cooling, model-incompatible, or explicitly excluded accounts are skipped.

Explicit session identifiers remain preferred. The first-user-message hash remains as a compatibility fallback and stores only a hash. Responses API chains must include `previous_response_id` as a stable affinity source so reconstructed histories remain consistently routed.

Tool-call and repair account IDs remain preferred-account signals. They follow the same soft-spill policy and never bypass admission limits.

## Upstream Failure Semantics

- Account 429: retain consumed RPM, apply existing account cooldown, release concurrency, and allow failover through a new admission.
- Upstream account/model `5/5` error: retain consumed RPM, release concurrency, and apply a short account/model-specific cooldown. Other models on that account remain eligible.
- 401, 403, 408, 425, and 5xx: preserve existing account-level failure/cooldown behavior.
- Failure after client-visible streaming output: preserve the existing no-failover rule to avoid duplicate or reordered output.
- All supporting accounts cooling: wait until the earliest cooldown ends, subject to queue timeout.
- No account supports the model: fail immediately rather than creating an unsatisfiable waiter.

A model-specific concurrency error detector must match the structured upstream error/status when available and use the verified `Concurrent limit reached for ...: N/N slots in use` message only as a compatibility fallback.

## Runtime Status and Admin UI

The existing dashboard gains a scheduler settings section with numeric inputs and toggles for every global field. Account editing gains inheritable account RPM, account/model concurrency, and per-supported-model concurrency overrides.

Runtime status exposes:

- Global pending count and oldest wait duration.
- Per-account total in-flight count.
- Per-account in-flight counts by model.
- Per-account rolling 60-second request count and next eligible time.
- Per-egress rolling request count, account count, and next eligible time.
- Existing cooldown and last-error state.

Changing settings takes effect immediately and wakes the queue. Lowering a concurrency limit does not cancel active requests; it blocks new admissions until usage drops below the new value. Account/model/proxy edits trigger queue reevaluation.

## Validation Matrix

Focused scheduler tests must cover:

- Five simultaneous leases for one account/model; the sixth waits and exactly one waiter wakes on release.
- Different models on one account receive independent concurrency pools.
- The 21st account request in a rolling minute waits until a timestamp expires.
- Failed and cancelled-after-admission upstream requests still consume RPM.
- Two accounts sharing one normalized proxy admit 30 combined requests and queue the 31st.
- Different proxies have independent windows.
- Direct accounts are unlimited by egress when disabled and share the configured window when enabled.
- Explicit affinity remains stable while capacity is available.
- Full preferred account spills to another account and updates affinity.
- Tool-call and repair preferences remain soft and capacity-aware.
- Unlimited waiting, queue timeout, queue full, cancellation, and hot configuration update.
- Model-specific `5/5` cooldown does not disable other models.
- Account 429 cooldown and failover consume a second admission.
- No supporting account returns immediate 503.
- Existing model filtering, weights, account cooldown, tool-call binding, and streamed-output no-failover behavior remain intact.

State-store and admin-route tests must cover defaults, normalization of older state, valid overrides, rejected values, clearing overrides, and immediate settings updates. UI verification must confirm all controls round-trip through the existing admin settings endpoint and runtime counters render without proxy credentials.

## Operational Acceptance

After deployment, normal capacity excess should appear as bounded queue wait rather than routine upstream `5/5`, account 429, and cascading `no_account_available` responses. Upstream limit errors remain observable because external traffic or state drift can still consume capacity outside this process.

Acceptance uses the admin runtime view and debug summaries to compare:

- Queue depth and oldest wait.
- Upstream `5/5` errors.
- Upstream/account 429 responses.
- Client `503 no_account_available` responses.
- Per-account and per-egress rolling utilization.

The goal is not to suppress all upstream limit errors. It is to make local traffic obey configured capacity before reaching the portal and to retain upstream errors as evidence of external load or limit drift.

## Exclusions

- Redis, distributed locking, or cross-instance admission coordination.
- Persisting live waiters or restoring queued HTTP requests after restart.
- Changing portal retry policy unrelated to capacity admission.
- Hard session pinning that waits for a full account while other eligible accounts are available.
- Per-account overrides for a shared proxy's RPM.
