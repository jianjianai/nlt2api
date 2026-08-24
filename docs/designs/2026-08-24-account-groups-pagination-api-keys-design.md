# Account Groups, Pagination, and Scoped API Keys

## Status

Approved design for implementation planning.

## Goals

- Add stable server-side pagination, search, status filtering, group filtering, and sorting to the account workspace.
- Let one account belong to zero or more account groups.
- Let each group own zero or more client API keys, with each key scoped to exactly one group.
- Preserve the existing global client API key as a master key that can access all accounts.
- Enforce group scope across model discovery, scheduling, retries, continuation, tool-call repair, sticky affinity, and stored Responses state.
- Provide account-group and API-key management in the existing administration workspace.
- Remove the gray theme and migrate saved gray selections to the night theme. Keep the selected account layout identical across light and night themes, changing only semantic theme tokens.

## Non-goals

- Per-group RPM, concurrency, cost, or quota limits.
- Per-group model allowlists independent of account model availability.
- Multi-group API keys.
- User roles or admin permission levels.
- Duplicating account capacity when an account belongs to multiple groups.

## Domain Model

Persistent state moves from version 1 to version 2. Existing state is normalized in place through the current state-store load and mutation boundary.

### Accounts

Each managed account gains:

```ts
groupIds: string[]
```

An account may belong to multiple groups or remain ungrouped. Group IDs are deduplicated and must reference existing groups when written. Account RPM, model concurrency, sessions, cooldowns, proxies, and egress capacity remain account-global resources regardless of how many groups reference the account.

### Account Groups

```ts
interface AccountGroup {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Names are unique after trimming and case folding. Disabling a group prevents its keys from starting new requests but does not disable member accounts, because those accounts may be used through another group or the global key.

Deleting a group atomically removes its ID from all accounts and revokes all keys owned by the group. The admin UI must confirm the affected account and key counts before deletion.

### Group API Keys

```ts
interface GroupApiKey {
  id: string;
  groupId: string;
  name: string;
  prefix: string;
  secretDigest: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Every key belongs to exactly one group. Key names are unique within a group after trimming and case folding. Secrets use cryptographically random bytes. Persistent state stores only a SHA-256 digest and a short display prefix. The plaintext secret is returned only by successful create or rotate responses and is never available from list or get endpoints.

## Authentication and Authorization

Client authentication returns a principal rather than `void`:

```ts
type ClientPrincipal =
  | { scope: "global" }
  | { scope: "group"; groupId: string; apiKeyId: string };
```

The current environment-backed client API key remains a global master key. A valid enabled group key for an enabled group returns a group principal. Invalid keys, disabled keys, and keys for disabled groups all return the same 401 response so the gateway does not disclose whether a key or group exists.

The principal is passed through both generation routes, model discovery, request validation, chat execution, completion, and scheduler acquisition. It is not reconstructed downstream from request headers.

The scheduler filters enabled model-capable accounts before affinity ranking:

- A global principal may use every otherwise eligible account.
- A group principal may use only accounts whose `groupIds` contains the principal's `groupId`.
- A group with no eligible account returns the existing no-available-account class of error and never falls back to global accounts.

The same principal remains fixed through retries, continuation calls, tool-call repair, account snapshots, sticky affinity, and failover. Membership is checked again whenever the scheduler selects a replacement account.

`/v1/models` and preflight model validation expose only models supported by accounts visible to the principal.

Stored Responses state records its authorization scope. A group principal may read only state created by the same group. A global principal may read state created by any scope. A group principal may not read global state or another group's state. Scope mismatch returns the same not-found behavior as a missing response state.

## Persistence and Migration

When version 1 state is opened:

- Existing accounts receive `groupIds: []`.
- `groups` and `groupApiKeys` start empty.
- Existing accounts, sessions, proxies, scheduler settings, analytics settings, and the global environment key behavior remain unchanged.
- No default group is created.

All group, membership, and key mutations use the existing state-store atomic mutation boundary. Group references are validated before commit. Persistent normalization removes duplicate group IDs but does not silently accept unknown IDs from an admin write.

## Admin APIs

### Paginated Accounts

```text
GET /api/admin/accounts?page=1&pageSize=20&query=&groupId=&status=&sort=
```

Supported page sizes are 20, 50, and 100, with 20 as the default. Search covers account label, email, and proxy. Group and enabled-status filters compose with search. The default order is creation time descending, with account ID as a stable secondary key.

Response:

```ts
interface PaginatedAccountsResponse {
  accounts: PublicAccount[];
  pagination: {
    page: number;
    pageSize: 20 | 50 | 100;
    total: number;
    pageCount: number;
  };
}
```

Out-of-range pages return the final valid page when records exist and page 1 for an empty result. Account creation and PATCH requests accept `groupIds`. Existing field validation remains unchanged.

`/api/admin/status` stops returning the complete account credential list. It returns runtime counts and at most six account summaries for the overview. The proxy-pool bulk direct-account assignment becomes a server-side action so it does not depend on the browser holding every account.

### Groups

```text
GET    /api/admin/account-groups
POST   /api/admin/account-groups
PATCH  /api/admin/account-groups/:id
DELETE /api/admin/account-groups/:id
```

Group list responses include account and key counts required by the navigation and delete confirmation. Delete responses are idempotent only after the caller has resolved an existing group; a missing group returns the existing admin not-found contract.

### Group Keys

```text
GET    /api/admin/account-groups/:id/api-keys
POST   /api/admin/account-groups/:id/api-keys
POST   /api/admin/account-groups/:id/api-keys/:keyId/rotate
PATCH  /api/admin/account-groups/:id/api-keys/:keyId
DELETE /api/admin/account-groups/:id/api-keys/:keyId
```

GET returns public key metadata for the selected group and never returns a secret digest. Create and rotate return a one-time `secret` plus the public key metadata. Subsequent reads never return the secret or digest. PATCH changes name or enabled state. DELETE revokes the key immediately for new requests.

## Admin Interaction Design

The account workspace uses the approved left group-navigation layout.

### Desktop

- A left rail lists `All accounts`, each group, and `Ungrouped`, with server-provided counts.
- Selecting a group updates the server query and resets pagination to page 1.
- The right pane contains search, enabled-status filter, page-size selector, account list, and paginator.
- The selected group header exposes `Edit group`, `Manage API keys`, and `Add account` actions.
- The group-rail add control creates a group.

### Mobile and Narrow Widths

The group rail becomes a top `Account group` select control. Account content keeps the existing full width. No persistent narrow rail remains beside the cards.

### Account Membership

- The add-account dialog supports multi-select group assignment.
- The expanded account controls gain an `Account groups` section with a checkbox list.
- Saving membership reloads the current account page, group counts, and runtime summaries.
- An ungrouped account remains usable through the global key but cannot be used through a group key.

### Key Management

The selected group's `Manage API keys` action opens a group-key list. Admins can create, rotate, enable, disable, and revoke keys. A create or rotate result uses the existing secret-display component and explicitly states that the plaintext cannot be viewed again after leaving the result.

## Pagination Behavior

- Search, group, status, sort, or page-size changes reset the page to 1.
- Expanding an account never changes the current page.
- Deleting the last account on a page reloads the previous valid page.
- Create, edit, membership update, verification, proxy assignment, model update, and limit update reload the current page and preserve active filters where possible.
- The paginator displays first, previous, nearby page numbers, next, and last without changing layout width as the current page changes.

## Theme Changes

The theme contract retains only light and night themes.

- The gray theme option and its state branches are removed.
- A persisted gray theme value is parsed as night on first load after upgrade.
- The night theme uses the same account layout, surfaces, spacing, borders, controls, and hierarchy approved for the new account workspace.
- Only semantic background, text, border, accent, success, warning, and error tokens differ between light and night themes.
- Existing unrelated page structures are not redesigned as part of this feature.

## Error Handling

- Invalid pagination parameters receive a 400 response instead of silent coercion, except an out-of-range positive page which resolves to the last valid page.
- Unknown group IDs in account writes receive a field-specific 400 response.
- Duplicate group names or key names receive a 409 conflict.
- Invalid, disabled, or revoked client keys and disabled groups receive the same 401 response.
- A scoped request with no eligible account never widens to another group or the global pool.
- Group delete confirmation reports account and key counts before the destructive request.
- Key create or rotate failures never display or persist a partial plaintext secret.

## Verification

### State and Security

- Reopen a version 1 fixture and prove accounts, sessions, proxies, and settings survive with empty `groupIds`.
- Create and rotate a key, then prove persistent state contains only digest and prefix while plaintext appears only in that response.
- Verify unknown group references cannot be persisted.

### Authorization

- Prove the global key can schedule every otherwise eligible account.
- Prove each group key schedules only accounts containing that group ID, including accounts shared by multiple groups.
- Prove account RPM, concurrency, and egress usage remain globally shared for multi-group accounts.
- Prove model listing, preflight validation, retries, continuation, tool repair, sticky affinity, and failover do not cross scope.
- Prove stored Responses state cannot be reused across group boundaries and that the global principal retains master access.

### Pagination and Management

- Cover combined search, group, status, page size, stable sorting, empty results, out-of-range pages, and deletion of the final row on a page.
- Cover group create, rename, disable, delete cleanup, membership replacement, and key lifecycle endpoints.
- Verify proxy-pool bulk assignment works without a full browser-side account collection.

### Frontend

- Verify group selection resets page state and loads the requested server page.
- Verify current filters survive account mutations where applicable.
- Verify the mobile group selector replaces the rail without overlapping controls.
- Verify one-time key display and reset behavior.
- Verify only light and night theme choices remain and a stored gray value activates night.

## Delivery Sequence

1. Add version 2 state normalization, group entities, membership integrity, and digest-only keys.
2. Return principals from client authentication and enforce scope in models, Responses state, chat execution, and scheduler selection.
3. Add group, key, paginated-account, and server-side bulk-assignment admin APIs.
4. Split the admin account data flow from the full status snapshot.
5. Implement the approved group rail, account membership controls, pagination, and key management.
6. Remove gray theme selection, migrate saved gray values, and align night theme with the approved layout.
7. Run focused state migration, authorization, API contract, and frontend boundary checks.
