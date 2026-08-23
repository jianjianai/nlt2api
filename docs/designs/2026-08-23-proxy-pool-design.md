# Proxy Pool, Health Checking, Assignment and Rotation

## Status

Approved design awaiting implementation-plan approval.

## Objective

Add a persistent proxy pool that accepts bulk pasted proxies, detects supported protocols, tests candidates before assignment, derives idle/in-use/error status, assigns healthy proxies to accounts, and optionally rotates proxies after transport failures.

The feature must preserve existing direct per-account proxy configuration and the unified scheduler. It must not classify portal rate limits, model capacity, account authentication, or valid upstream HTTP failures as proxy failures.

## Verified Current Behavior

- `ManagedAccount.proxy` currently stores the complete optional proxy URL.
- `proxy.ts` validates and dispatches HTTP, HTTPS, SOCKS4, SOCKS4A, SOCKS5, SOCKS5H and `socks` URLs, including URL credentials.
- Account creation can accept one manually entered proxy before login verification.
- Changing an account proxy currently affects the next portal request and scheduler egress identity.
- `StateStore` serializes account/settings mutations, but has no proxy-pool entity or atomic proxy assignment operation.
- `portal-client.ts` owns transport, timeout, session refresh and bounded retry behavior.
- The scheduler uses immutable account/egress snapshots per real HTTP attempt, so proxy changes affect only later admissions.

## Corrected Session Rule

Changing, assigning, unbinding or rotating a proxy must not proactively clear the account session or log the account out.

The stored session is reused through the new egress. If the portal returns 401 or 403 on the new egress, the existing portal session-refresh path clears the stale session and logs in once. This rule applies uniformly to:

- Manual account proxy changes.
- Automatic proxy assignment during account creation.
- Manual pool assignment to a direct account.
- Automatic proxy-error rotation.
- Optional fallback from a failed proxy to direct egress.

## Persistent Data Model

Add `ProxyPoolEntry` to the version-1 persistent state without a schema-version migration:

```ts
interface ProxyPoolEntry {
  id: string;
  url: string;
  kind: "http" | "socks4" | "socks5";
  label?: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  failedAt?: string;
  retryAfter?: number;
}
```

Add `proxyPool: ProxyPoolEntry[]` to `PersistentState`. Older stores normalize to an empty pool.

Add `proxyPoolEntryId?: string` to `ManagedAccount`. Pool assignment atomically writes both the canonical URL and entry ID. Manual proxy entry clears `proxyPoolEntryId` unless the server intentionally resolves the same canonical URL to an existing pool entry.

`in_use` is derived from account bindings and is never persisted as a second owner. `checking` is an in-memory reservation state. Persisted error fields determine `error`; otherwise an unbound entry is `idle`.

## Proxy Pool Settings

Add one `proxyPool` settings object:

```ts
interface ProxyPoolSettings {
  autoAssignOnAccountCreate: boolean;
  autoRotateOnTransportError: boolean;
  retryCurrentRequestAfterRotation: boolean;
  directFallbackWhenExhausted: boolean;
  defaultImportProtocol: "http" | "socks5" | "socks4";
  healthCheckTimeoutSeconds: number;
  errorRetryCooldownSeconds: number;
}
```

Defaults:

- Auto-assign on account creation: off.
- Auto-rotate on transport error: off.
- Retry current request after successful rotation: on.
- Fall back to direct when no idle proxy exists: off.
- Default shorthand protocol: `http`.
- Health-check timeout: 10 seconds.
- Error retry cooldown: 300 seconds.

All fields are persisted through the existing admin settings chain and take effect without restart.

## Import Grammar

Bulk import accepts one proxy per non-empty line:

- Full URL: `socks5://user:pass@host:1080`.
- Host and port: `host:port`.
- Host, port, username and password: `host:port:user:pass`.
- Credentials before host: `user:pass@host:port`.
- Bracketed IPv6: `[2001:db8::1]:1080` and URL equivalents.

Full URLs preserve their supported protocol alias. Shorthand lines use the configured default protocol.

Credentials are URL-encoded during canonicalization. Hostnames are normalized by URL parsing. Empty lines are ignored. Canonical complete URLs are deduplicated. Import limits bound line count and line length.

Import is partially successful: each line reports `created`, `existing` or `invalid` with an error. One malformed line does not roll back valid lines.

## Status Model

Public authenticated admin state for each entry includes:

- `idle`: no account binding, no active reservation and no unexpired error cooldown.
- `checking`: an in-memory health check or assignment reservation is active.
- `in_use`: an account has `proxyPoolEntryId` matching the entry.
- `error`: the latest health/transport result failed and has not been superseded by a successful health check.

Status precedence is `checking`, then `error`, then `in_use`, then `idle`. A failed bound proxy therefore remains visibly `error` while still naming its bound account.

The list also exposes bound account ID/label, kind, complete canonical URL for authenticated administrators, masked URL, timestamps, retry time and a bounded sanitized error message.

Proxy credentials must not enter debug records, scheduler egress snapshots, logs or unauthenticated APIs.

## Health Check

Health checks use the same production dispatcher implementation and the configured timeout. They perform a bounded GET through the proxy to the existing portal models endpoint rather than consuming chat RPM.

A successful transport and acceptable portal HTTP response marks the entry healthy. A proxy authentication response or transport failure marks it error. The response body is discarded within existing size and cleanup boundaries.

The allocator checks normal idle entries first, ordered by least recently healthy/oldest created. If none succeed, it may re-test error entries whose `retryAfter` has expired.

No background periodic checker is added. Recovery occurs through manual single/bulk checks or allocation after cooldown.

## Reservation and Atomic Assignment

`proxy-pool.ts` owns an in-memory set of reserved entry IDs. The StateStore remains the persistent owner.

Allocation flow:

1. Read pool entries and account bindings.
2. Select the first unbound, unreserved eligible entry.
3. Reserve its ID in memory.
4. Health-check outside the StateStore mutation lock.
5. On failure, persist error state, release reservation and continue.
6. On success, atomically re-check that the entry is still unbound and assign it to the target account.
7. Persist health state and account `proxy` plus `proxyPoolEntryId` in the same mutation.
8. Release the reservation and notify the scheduler.

Concurrent allocations cannot bind one entry to two accounts. A process crash loses only transient reservations; account binding remains the sole persisted `in_use` authority.

Unbinding or deleting an account automatically makes its pool entry idle. Deleting an in-use pool entry returns 409 unless an explicit future force operation is added.

## Account Creation

Manual proxy input takes precedence over pool auto-assignment.

When no manual proxy is provided and auto-assignment is enabled:

1. Create a provisional account or reserve a pool entry before verification using one bounded allocation flow.
2. Health-check and bind a proxy if available.
3. Verify portal login through the assigned proxy.
4. If no healthy proxy is available, create and verify the account through direct egress.
5. If verification fails, delete the account; any pool binding is thereby released.

The proxy is marked error only when verification failed because of a classified proxy transport error. Account credentials or portal rejection do not mark the proxy error.

## Manual Assignment

A direct account exposes 「分配代理」. The operation selects and health-checks one eligible pool proxy, then atomically binds it.

Accounts already using a proxy are not silently overwritten by this command. The existing proxy editor remains the explicit way to replace or clear a proxy.

Manual account proxy changes preserve the current session. If the next portal request receives 401/403, existing session refresh performs one login through the new egress.

## Proxy Transport Errors

Introduce `ProxyTransportError` carrying a sanitized reason and optional cause. It is emitted only when a configured proxy is involved and the failure occurs before a valid portal HTTP response or during the proxied body transport:

- Proxy TCP/connect failure.
- DNS failure.
- TLS handshake failure.
- HTTP proxy 407 or proxy authentication rejection.
- SOCKS authentication/handshake failure.
- Request-header or body inactivity timeout.
- Underlying connection termination before client-visible output.

Do not rotate for:

- Portal HTTP 429.
- Valid portal HTTP 5xx responses.
- Account 401/403 and session refresh.
- Model `N/N slots in use`.
- Client cancellation.
- Request validation, tool parsing or completion-shape errors.

## Automatic Rotation

Automatic rotation is considered only after the existing bounded retry path yields a proxy transport failure.

For one upstream round:

1. If the failed proxy is pool-bound, mark its pool entry error while keeping its account binding. A custom manually-entered proxy has no pool entry to mark.
2. If auto-rotation is enabled, reserve and health-check another eligible pool proxy.
3. On success, atomically replace the expected failed pool binding or expected custom proxy URL with the new entry.
4. Preserve the account session; do not proactively clear it.
5. Notify the scheduler so later admissions use the new egress.
6. If current-request retry is enabled, retry once using a fresh scheduler lease and account snapshot.
7. If the portal rejects the preserved session with 401/403, existing session refresh logs in once through the new proxy.
8. Do not rotate a second time in the same upstream round.

When no healthy proxy is available:

- If direct fallback is disabled, keep the failed pool binding or custom proxy on the account, expose pool failures as `error`, and surface the transport failure. Later requests may trigger another bounded rotation attempt after candidates recover.
- If direct fallback is enabled, remove the proxy and use direct egress. Preserve the session until the portal proves it invalid. Retry the current request only when its separate setting is enabled.

## Admin API

Add authenticated endpoints:

- `GET /api/admin/proxies`.
- `POST /api/admin/proxies/import`.
- `POST /api/admin/proxies/:id/check`.
- `POST /api/admin/proxies/check` for `error` or `all` scope.
- `DELETE /api/admin/proxies/:id`, rejecting in-use entries.
- `POST /api/admin/accounts/:id/assign-proxy`, restricted to direct accounts.

Extend `PATCH /api/admin/settings` with proxy-pool settings. Existing account PATCH remains the explicit direct proxy editor and maintains pool binding consistency.

## Admin UI

Add a 「代理池」 view or full-width account-page section containing:

- Bulk paste textarea.
- Default protocol selector.
- Import action and per-line result summary.
- Filters for all, idle, in use, error and checking.
- Counts for each state.
- Rows with address, kind, status, binding, last check, next retry and recent error.
- Actions for copy, check and delete.
- Bulk re-check action.

Add policy controls for all proxy-pool settings. Direct account cards gain 「分配代理」. Pool-bound accounts show the pool entry status.

The UI must reuse existing Vue state, API helper, design tokens, focus states, responsive grids and toast/error patterns. It must remain usable at 390px without horizontal overflow.

## Validation Matrix

Tests must cover:

- Every supported URL protocol and alias.
- Shorthand formats, credentials, bracketed IPv6 and URL encoding.
- Partial import, deduplication and bounded invalid input.
- Derived idle/in-use/error/checking states.
- Two concurrent assignments never receive one entry.
- Failed health checks mark error and continue to later candidates.
- Error cooldown and successful recovery.
- Account deletion/unbind returns an entry to idle.
- Manual proxy takes precedence during account creation.
- Auto-assign off/on and no-idle direct creation.
- Manual assignment restricted to direct accounts.
- Proxy changes preserve stored session.
- 401/403 after proxy change triggers the existing single login refresh.
- Transport failures rotate; 429/5xx/account auth/model capacity do not.
- At most one rotation per upstream round.
- Current-request retry and direct-fallback switch combinations.
- Scheduler sees the new egress only on a fresh lease.
- Admin authorization, sanitized errors and no credential leakage outside admin payloads.
- Desktop and 390px UI states, including empty, partial import failure, checking and error.

## Operational Boundaries

Pool entries, health history and account bindings persist. Reservations and checking state are single-process memory and reset on restart.

The current application remains single-instance for scheduling and proxy allocation. No Redis or cross-instance lock is introduced.

No production deployment, background periodic probing, automatic proxy acquisition from third parties, or proxy sharing across multiple accounts is included in this change.
