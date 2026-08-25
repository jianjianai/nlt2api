# Free Proxy Sync and Stable Account Egress Design

## Goals

Integrate the Rola free proxy list as a managed IPv4 proxy source for DeepInfra accounts. The system fetches candidates, filters and probes them, keeps a configured target count of proxy-backed accounts, replaces failed proxies without changing account identity, and records auditable sync results.

Account identity is stable. `ManagedAccount.id` owns billing history, usage history, model access, groups, weight, and scheduler overrides. A proxy is a replaceable egress resource. Proxy failure never deletes or recreates the account.

## Scope

- Source: `https://rola-ip.co/zh/tools/free-proxy-list` and its current daily list.
- Address family: public IPv4 only.
- Protocols: HTTP, HTTPS, SOCKS4, SOCKS5.
- Triggering: manual admin action and periodic background sync.
- Capacity: configurable target proxy-account count, default 20; direct accounts do not count.
- Ownership: all proxy-backed accounts are managed by the reconciler, including manually created proxy accounts. Direct accounts are never replaced.
- Probe gate: proxy handshake, DeepInfra `/models/list` HTTP 200, then minimal Kimi-K3 Chat request through the same egress.

## Domain Model

### Stable account

A proxy-backed account keeps its ID for its full billing lifetime. Replacing its proxy must preserve:

- account ID;
- billing and debug history;
- models;
- group memberships;
- weight;
- scheduler overrides;
- created timestamp and other business configuration.

Only the current proxy binding and egress-health lifecycle change.

### Proxy resource

Proxy pool entries gain lifecycle metadata:

- source: `manual` or `rola_free`;
- lifecycle: `active`, `failed`, or `archived`;
- last check and last healthy timestamps;
- failure count and reason;
- failed and archived timestamps;
- source metadata required for audit, such as country, reported latency, availability, and source snapshot date.

No proxy URL may be bound to more than one account. The existing normalized egress identity remains the uniqueness boundary.

### Account egress state

Proxy-backed accounts have an egress state independent of `enabled`:

- `active`: current proxy is healthy and schedulable;
- `replacing`: reconciliation is selecting and validating a replacement;
- `unavailable`: no replacement is currently available; account remains stored but cannot be scheduled.

The reconciler must never clear a failed proxy to direct fallback. Direct accounts are outside this state machine.

## Architecture

```text
RolaSource
  -> ProxyCandidateParser
  -> ProxyProbeService
  -> ProxyReconciler
  -> StateStore
```

### RolaSource

Fetches the current list and daily list. The source is an HTML table rather than a confirmed stable JSON API, so parsing is isolated behind one adapter. It emits raw rows and source metadata. A structure change is a batch failure and causes zero account or proxy mutations.

### ProxyCandidateParser

Parses IP, port, protocol, country, reported latency, availability, and last-checked data. It:

- accepts only public IPv4;
- rejects private, loopback, link-local, multicast, reserved, and documentation ranges;
- validates port range;
- maps HTTPS proxy rows to the existing HTTP proxy kind with an `https://` URL;
- canonicalizes and deduplicates candidates;
- excludes egress identities already bound to accounts;
- excludes archived proxies still within archive cooldown;
- ranks by availability, latency, and freshness.

### ProxyProbeService

Runs bounded concurrent checks with per-stage timeouts:

1. establish HTTP/SOCKS proxy transport;
2. fetch DeepInfra `/models/list` and require HTTP 200;
3. mint a fresh single-use Turnstile ticket and complete a minimal Kimi-K3 Chat request through that same proxy.

A ticket is minted per physical Chat probe and is never cached or reused. Probe logs never include proxy passwords, tickets, or request content.

### ProxyReconciler

Maintains the configured target count and repairs failed egresses. It is the only service allowed to perform automatic proxy replacement.

## Synchronization Flow

1. Fetch Rola current and daily sources.
2. Parse and validate IPv4 candidates.
3. Canonicalize, deduplicate, and rank candidates.
4. Check all existing proxy-backed accounts.
5. Mark transient failures without replacing until the failure threshold is reached.
6. Probe enough new candidates to repair failed accounts and fill the target account count.
7. Replace failed proxies on existing accounts with one atomic state transaction.
8. Create new accounts only when healthy proxy-account count is below the configured target and no existing unavailable account can be repaired.
9. Archive old proxies and write batch audit results.
10. Notify the scheduler once after the state transaction commits.

## Stable Proxy Replacement

Replacement is an atomic account-preserving operation:

```text
proxy reaches failure threshold
  -> account egress state = replacing
  -> validate candidate
  -> archive old proxy
  -> bind candidate to the same account ID
  -> account egress state = active
  -> scheduler notification
```

If candidate validation or persistence fails:

- account ID and configuration remain unchanged;
- the old proxy value is not cleared to direct;
- account egress state becomes `unavailable`;
- the next sync retries replacement;
- no half-bound proxy entry is visible.

New account creation is reserved for increasing capacity toward the configured target. Once created, that account ID is permanent and future failures update only its proxy.

## Scheduling and Concurrency

Proxy sync settings extend proxy-pool settings:

- enabled;
- interval minutes, default 15 and minimum 5;
- target account count, default 20;
- candidate limit per batch;
- probe concurrency, default 10;
- probe timeout seconds;
- failure threshold, default 3;
- archive cooldown hours.

Only one sync batch runs per process. Periodic triggers skip if a batch is active. Repeated manual triggers return the active batch ID. On restart, persisted running batches become `interrupted`; the next cycle starts a new batch.

The periodic job starts from a Nitro plugin. It does not run immediately on every service start; the first automatic run occurs after a full configured interval. Administrators can run it immediately from the panel.

## Admin API

- `GET /api/admin/proxy-sync`: settings, current run, and latest summary.
- `PATCH /api/admin/proxy-sync`: update validated settings.
- `POST /api/admin/proxy-sync/run`: start or return the active run.
- `GET /api/admin/proxy-sync/runs`: paginated run history.
- `GET /api/admin/proxy-sync/runs/:id`: candidate, probe, replacement, and error details.

The proxy-pool workspace adds a free-proxy sync section with enablement, target account count, interval, concurrency, failure threshold, manual run command, latest batch metrics, and proxy source/lifecycle indicators.

## Audit Model

Each run records:

- trigger: manual or scheduled;
- started, completed, or interrupted timestamps;
- fetched, parsed, skipped, probed, healthy, failed, replaced, archived, and created counts;
- candidate rejection reasons;
- account ID, old proxy ID, new proxy ID, and duration for replacements;
- source URL and source snapshot metadata.

Secrets, typed prompts, Turnstile tickets, and proxy passwords are never persisted in audit output.

## Failure Safety

- Source fetch or HTML parse failure causes zero proxy/account changes.
- One failed candidate does not abort the batch.
- Account replacement is atomic and never changes account ID.
- A failed proxy never falls back to direct.
- A proxy remains unique to one account.
- Existing direct accounts are untouched.
- Replacement failure leaves the stable account unavailable for later repair.
- State mutation and scheduler notification occur once per committed reconciliation.

## Verification

Tests cover:

- Rola HTML table parsing and column-order changes;
- incompatible page structure with zero state mutation;
- public IPv4 filtering, reserved-range rejection, and port validation;
- HTTP/HTTPS/SOCKS4/SOCKS5 canonicalization and deduplication;
- one normalized egress per account;
- DeepInfra catalog and minimal Chat probe gates;
- transient failure threshold and cooldown;
- stable account ID and unchanged billing/configuration across replacement;
- unavailable state when no candidate is healthy, with no direct fallback;
- manual/periodic mutual exclusion and idempotence;
- interrupted-run recovery;
- audit redaction.

One integration test drives a fake Rola source and fake proxy probes through the complete reconciliation path. Production validation runs one manual sync with a low candidate limit, confirms successful accounts through `/v1/models` and minimal Chat, then enables the periodic schedule.
