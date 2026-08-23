# Proxy Pool Implementation Plan

## Source Design

Implement `docs/designs/2026-08-23-proxy-pool-design.md` exactly as approved. Preserve all unrelated local changes. Proxy changes must preserve the stored portal session; only an observed 401/403 may trigger the existing one-time login refresh.

## Phase 1: Persistent Contract and Import Parser

### Files

- `server/utils/types.ts`
- `server/utils/state-store.ts`
- `server/utils/proxy.ts`
- `tests/state-store.test.ts`
- `tests/proxy.test.ts`

### Changes

1. Add `ProxyPoolEntry`, `ProxyPoolSettings`, authenticated public pool-state types and default settings.
2. Extend `PersistentState` with `proxyPool`; normalize older version-1 stores to an empty pool.
3. Extend `ManagedAccount` with optional `proxyPoolEntryId` and keep it consistent with canonical `proxy` values.
4. Normalize pool entries, reject duplicate IDs/URLs and drop invalid persisted entries without affecting accounts.
5. Implement a pure bounded bulk-import parser supporting complete URLs, `host:port`, `host:port:user:pass`, `user:pass@host:port` and bracketed IPv6.
6. Reuse current URL parsing and protocol alias normalization. Shorthand uses the supplied default protocol.
7. Add StateStore methods for list/import/update-health/delete and atomic account binding/unbinding. Delete must reject an entry bound to an account.
8. Add tests for defaults, old-state compatibility, partial import, deduplication, credentials, IPv6, URL encoding, invalid bounds and binding-derived status inputs.

### Verification

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/state-store.test.ts tests/proxy.test.ts
```

Done when the persistent contract and parser pass without network access.

## Phase 2: Proxy Pool Service and Health Checking

### Files

- `server/utils/proxy-pool.ts` (new)
- `server/utils/proxy.ts`
- `server/utils/portal-client.ts`
- `tests/proxy-pool.test.ts` (new)
- `package.json`

### Changes

1. Implement `ProxyPoolService` with injected StateStore, health checker, clock and scheduler notification dependencies.
2. Maintain in-memory entry reservations and checking IDs. Never persist transient checking state.
3. Add a bounded portal health probe through the existing dispatcher and timeout path. Discard bodies and close resources.
4. Classify HTTP proxy 407, SOCKS/TCP/DNS/TLS/connect/timeouts as proxy-health failures. Do not classify valid portal HTTP 429/5xx/account responses as transport failures.
5. Allocate idle entries first by least-recently-healthy/oldest-created, then retry eligible error entries after cooldown.
6. After a successful probe, use one StateStore mutation to re-check availability and bind the entry to the account.
7. Preserve the account session during assignment/unassignment.
8. Implement single/bulk health checks, error marking, recovery and sanitized runtime snapshots.
9. Add deterministic tests for reservation concurrency, candidate skipping, cooldown, recovery, derived states, cleanup and no duplicate assignment.
10. Add the new test file to the project test command.

### Verification

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/proxy-pool.test.ts tests/proxy.test.ts tests/state-store.test.ts
```

Done when two concurrent allocations cannot bind one proxy and no health-check path leaks resources.

## Phase 3: Admin API and Account Assignment

### Files

- `server/api/admin/proxies.get.ts` (new)
- `server/api/admin/proxies/import.post.ts` (new)
- `server/api/admin/proxies/check.post.ts` (new)
- `server/api/admin/proxies/[id]/check.post.ts` (new)
- `server/api/admin/proxies/[id].delete.ts` (new)
- `server/api/admin/accounts/[id]/assign-proxy.post.ts` (new)
- `server/api/admin/accounts.post.ts`
- `server/api/admin/accounts/[id].patch.ts`
- `server/api/admin/accounts/[id].delete.ts`
- `server/api/admin/settings.patch.ts`
- `server/api/admin/status.get.ts`
- `tests/proxy-pool.test.ts`
- existing admin-route tests in `tests/core.test.ts` or a focused new test file if required

### Changes

1. Add authenticated list/import/check/delete endpoints with strict request bounds.
2. Extend settings validation for all proxy-pool policy fields.
3. Account creation order: manual proxy first; otherwise optional pool allocation; otherwise direct. Failed account creation releases a pool binding.
4. Manual assignment works only for direct accounts and returns a clear 409 for already-proxied accounts.
5. Existing account proxy editor preserves session and resolves/clears pool binding consistency.
6. Account deletion automatically frees the derived pool binding.
7. Status payload includes pool counts and checking state; complete URLs are returned only from authenticated admin APIs.
8. Notify scheduler after committed egress changes.
9. Add route-level tests for auth, import response, delete-in-use rejection, auto-assign policy, manual precedence and session preservation.

### Verification

Run focused proxy-pool/admin tests selected during implementation.

Done when all admin operations are authenticated, atomic and preserve sessions.

## Phase 4: Transport Error Classification and Automatic Rotation

### Files

- `server/utils/proxy.ts`
- `server/utils/portal-client.ts`
- `server/utils/chat-service.ts`
- `server/utils/proxy-pool.ts`
- `tests/proxy-pool.test.ts`
- `tests/chat-validation.test.ts`
- `tests/core.test.ts`

### Changes

1. Add `ProxyTransportError` with sanitized reason and optional cause.
2. Wrap only configured-proxy transport failures: connect/DNS/TLS/SOCKS/auth/407/timeouts and pre-output connection termination.
3. Keep valid portal HTTP responses, including 429/5xx/401/403, as existing PortalError paths.
4. After bounded internal retries exhaust with ProxyTransportError, ask ProxyPoolService to mark and rotate the bound pool entry.
5. Preserve session during rotation. Existing 401/403 refresh remains the only proactive login replacement.
6. Limit one proxy rotation per upstream round.
7. On successful rotation, optionally retry the current request with a new scheduler lease/account snapshot.
8. On pool exhaustion, optionally unbind to direct; retry only when the separate current-request switch is enabled.
9. Ensure old immutable scheduler leases retain old egress while each new attempt sees the committed replacement.
10. Add tests proving transport-only rotation, no rotation for portal 429/5xx/auth/model capacity, one-rotation limit, retry/direct-fallback combinations and session preservation.

### Verification

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/proxy-pool.test.ts tests/chat-validation.test.ts tests/core.test.ts tests/account-scheduler.test.ts
```

Done when failure classification and one-rotation semantics are exact.

## Phase 5: Management Panel

### Files

- `app/App.vue`
- `app/assets/main.css`

### Changes

1. Add proxy-pool payload, settings, status, checking and import-result types.
2. Add a 「代理池」 tab or full-width operational section.
3. Build bulk paste import with visible default protocol, per-line result summary and bounded loading/error states.
4. Add all/idle/in-use/error/checking filters and counts.
5. Render address, kind, state, account binding, health/retry timestamps and bounded error.
6. Add copy, check, delete and bulk-recheck actions.
7. Add policy controls for auto-assign, auto-rotate, retry-current-request, direct fallback, protocol, timeout and cooldown.
8. Add 「分配代理」 only for direct accounts. Show pool binding state for bound accounts.
9. Preserve existing explicit proxy editor. Clarify that changing proxy keeps the current session until the portal rejects it.
10. Reuse current tokens, focus handling, toasts and responsive patterns; validate 390px without horizontal overflow.

### Verification

Run `corepack pnpm typecheck`, then inspect the live page at the Vite Local URL with desktop and 390px viewports using representative empty, checking, partial-import and error states.

Done when every approved operation and policy is accessible and responsive.

## Phase 6: Documentation and Final Regression

### Files

- `README.md`
- `breezell/NEXT_GOAL.md`
- `breezell/TODO.md`
- `breezell/breezell_report.md`

### Changes

1. Document import forms, status derivation, policy defaults, session preservation and transport-only rotation.
2. Document single-process reservation/checking limits and no background probing.
3. Record that proxy credentials remain admin-only and are excluded from debug/scheduler outputs.
4. Update local project state; do not claim or perform production deployment.

### Final Verification

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Also grep for `TEMP_PROBE` and verify zero leftovers. Stop after these pass. Production deployment remains a separately authorized operation.
