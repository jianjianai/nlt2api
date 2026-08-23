# Scheduler Admission Queue Implementation Plan

## Source Design

Implement `docs/designs/2026-08-23-scheduler-admission-queue-design.md` exactly as approved. Preserve unrelated local changes in every touched file.

## Phase 1: Persisted Configuration Contract

### Files

- `server/utils/types.ts`
- `server/utils/state-store.ts`
- `server/api/admin/settings.patch.ts`
- `server/api/admin/accounts/[id].patch.ts`
- `tests/state-store.test.ts`

### Changes

1. Add `SchedulerSettings`, `AccountSchedulerOverrides`, scheduler runtime snapshot types, and the new fields on `ProxySettings`, `ManagedAccount`, and `PublicAccount`.
2. Define one exported scheduler-defaults constant used by normalization, runtime resolution, the admin API, and UI payloads. Defaults are concurrency 5, account RPM 20, proxy RPM 30, direct limiting disabled with RPM 30, sticky TTL 1800 seconds, queue timeout 0, and queue size 0.
3. Extend state normalization so older `accounts.json` files gain defaults without a schema-version change. Normalize account overrides, retain only supported-model concurrency entries, and drop invalid persisted values.
4. Extend `ProxySettingsUpdate` and `StateStore.updateSettings()` to persist scheduler settings atomically with existing settings.
5. Extend account update input and normalization for nullable scheduler overrides. Removing a model removes its override.
6. Add bounded integer validation to the settings and account PATCH routes. Zero is accepted only for queue timeout/size. Null clears account overrides.
7. Add state-store tests for old-state defaults, round-trip persistence, override precedence inputs, clearing, stale model override removal, and invalid persisted values.

### Verification

Run:

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/state-store.test.ts
```

Done when the persisted contract round-trips and old state receives the approved defaults.

## Phase 2: Unified Admission Scheduler

### Files

- `server/utils/account-scheduler.ts`
- `server/utils/proxy.ts`
- `server/utils/types.ts`
- `tests/account-scheduler.test.ts` (new)
- `package.json`

### Changes

1. Add an egress-identity helper to `proxy.ts` that returns a normalized internal key from protocol, lowercase hostname, and effective port. Do not include credentials or paths. Return the direct-egress identity for accounts without proxies.
2. Refactor `AccountScheduler` around an `AccountLease` result and options object containing model, sticky key, preferred account, excluded accounts, and abort signal.
3. Inject scheduler dependencies for tests: current time, timer scheduling/cancellation, and settings/account loaders. Production defaults use `Date.now`, normal timers, and `stateStore`.
4. Maintain per-account/per-model in-flight counters, per-account rolling timestamp windows, per-egress rolling timestamp windows, model-specific cooldowns, sticky assignments, tool-call assignments, and FIFO waiter metadata.
5. Implement one synchronous admission decision that ranks candidates, checks all limits, and reserves all applicable state atomically. Only concurrency is released; rolling timestamps remain.
6. Implement event-driven waiting with one earliest-eligibility timer. Wake on lease release, RPM expiry, cooldown expiry, settings/account change, abort, and timeout.
7. Select the oldest currently executable waiter to avoid cross-model/global head-of-line blocking.
8. Enforce optional queue timeout and max size. Raise typed scheduler errors for `queue_timeout`, `queue_full`, and immediate no-account conditions with retry delay when known.
9. Keep soft affinity: preferred/sticky account first, then spill to another admissible account; update affinity only after successful reservation.
10. Add scheduler methods for settings/account changes and a sanitized runtime snapshot.
11. Add model-specific cooldown handling for verified upstream concurrency errors while retaining existing account-level cooldown methods.
12. Add a dedicated test suite with a deterministic fake clock covering concurrency isolation, rolling RPM, shared proxies, direct egress, waiter fairness, cancellation, timeout, queue full, hot settings changes, affinity spillover, cooldowns, and idempotent release.
13. Add the new test file to `package.json`'s existing test command.

### Verification

Run:

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/account-scheduler.test.ts
```

Done when deterministic tests prove atomic reservations and exact wake-up behavior without real sleeps.

## Phase 3: Upstream Request Integration

### Files

- `server/utils/chat-service.ts`
- `server/utils/response-api.ts`
- `server/routes/v1/chat/completions.post.ts`
- `server/routes/v1/responses.post.ts`
- `tests/chat-validation.test.ts`
- `tests/response-api.test.ts`

### Changes

1. Change `getCompletion()` to acquire an `AccountLease` immediately before each `portalClient.requestChat()` attempt and release it in `finally`.
2. Pass model, sticky key, preferred account, excluded accounts, and the client abort signal into acquisition.
3. Preserve the existing retry count, streamed-output no-failover rule, debug-call capture, and account-level failure semantics.
4. Ensure every repair, thinking continuation, and failover obtains a new lease and consumes a new RPM timestamp.
5. Detect structured account/model concurrency errors first; use the verified `Concurrent limit reached for ...: N/N slots in use` message only as a fallback. Apply model-specific cooldown instead of cooling the whole account.
6. Map typed queue errors to OpenAI-compatible HTTP 429 responses and attach `Retry-After` when present.
7. Add a stable Responses affinity input from `previous_response_id`. Preserve explicit session-header/body precedence and first-user-message fallback for Chat compatibility.
8. Pass endpoint `AbortSignal` through waiting and execution paths so disconnected queued requests are removed immediately.
9. Extend request tests for queue error mapping, abort propagation, previous-response affinity, model-specific cooldown routing, and one admission per real upstream attempt.

### Verification

Run:

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/chat-validation.test.ts tests/response-api.test.ts tests/account-scheduler.test.ts
```

Done when request lifecycles use leases without changing validated response/stream behavior.

## Phase 4: Admin Runtime API and Hot Updates

### Files

- `server/api/admin/status.get.ts`
- `server/api/admin/settings.patch.ts`
- `server/api/admin/accounts/[id].patch.ts`
- `server/api/admin/accounts/[id].delete.ts`
- `server/api/admin/accounts.post.ts`
- `server/api/admin/accounts/[id]/models.post.ts`
- `server/api/admin/accounts/[id]/verify.post.ts`
- `tests/core.test.ts`
- `tests/state-store.test.ts`

### Changes

1. Add the sanitized scheduler runtime snapshot to the status response: pending count, oldest wait, per-account model in-flight/RPM state, and per-egress account count/RPM/next eligibility.
2. Notify the scheduler after settings changes and after account creation, verification model refresh, updates, disabling, proxy changes, model changes, and deletion.
3. Ensure queue reevaluation uses freshly persisted account/settings state and never exposes proxy credentials.
4. Add API-level tests for accepted/rejected scheduler settings, account overrides, sanitized status output, and hot-update notifications.

### Verification

Run the narrow API/state tests selected during implementation from `tests/core.test.ts` and `tests/state-store.test.ts`.

Done when an admin mutation immediately changes admission decisions without restart.

## Phase 5: Management Panel

### Files

- `app/App.vue`
- `app/assets/main.css`

### Changes

1. Extend API payload and account types with scheduler settings, account overrides, and runtime snapshot fields.
2. Add a scheduler settings section using numeric inputs for concurrency/RPM/TTL/queue bounds and a toggle for direct-egress limiting.
3. Represent unlimited timeout/queue length explicitly as zero and display the effective meaning next to the control.
4. Extend account editing with inheritable account RPM/concurrency overrides and per-supported-model concurrency rows.
5. Display queue pending count/oldest wait, per-account in-flight and RPM usage, and sanitized egress-group utilization.
6. Keep proxy credentials confined to the existing authenticated account detail/edit surfaces; runtime egress rows show only stable display IDs.
7. Reuse the existing PATCH settings flow, account busy state, toast handling, spacing, typography, and responsive patterns. Do not add a frontend store or parallel settings endpoint.
8. Ensure long model IDs and egress IDs wrap without changing control dimensions or overlapping adjacent content.

### Verification

Run:

```powershell
corepack pnpm typecheck
```

Then start the existing Vite development server and inspect the authenticated admin screen at its printed Local URL on desktop and mobile widths. Confirm controls round-trip, runtime values update, and no credentials appear in egress status.

Done when every approved limit is editable and every runtime counter is readable at both widths.

## Phase 6: Integrated Regression and Operational Readiness

### Files

- `README.md`
- `.env.example` only if the implementation keeps any environment fallback; otherwise leave unchanged.
- Existing tests as required by failures introduced at the changed boundaries.

### Changes

1. Document scheduler defaults, override precedence, queue error codes, explicit session headers, soft affinity, and the single-process limitation.
2. State that live waiters and counters reset on process restart.
3. Document runtime interpretation: local queueing should reduce ordinary upstream `5/5`, account 429, and cascading 503 events, while residual events indicate external traffic or limit drift.
4. Do not add Redis, distributed coordination, persisted waiters, hard affinity, or per-account proxy-RPM overrides.

### Final Verification

Run the repository's existing complete check once:

```powershell
corepack pnpm test
```

If it passes, stop. The focused phase checks and this full suite cover the changed backend contracts; do not stack an additional production build unless a module-boundary failure or repository rule requires it.

After deployment approval in a later step, compare production debug summaries and the admin runtime view for queue depth, oldest wait, upstream `5/5`, account 429, client 503, and per-egress utilization. Deployment is not part of this implementation plan unless separately authorized.
