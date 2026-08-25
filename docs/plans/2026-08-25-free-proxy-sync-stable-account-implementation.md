# Free Proxy Sync and Stable Account Egress Implementation Plan

## Phase 1: Persisted Contracts

1. Extend proxy pool settings with sync enablement, interval, target account count, candidate limit, probe concurrency, probe timeout, failure threshold, and archive cooldown.
2. Extend proxy entries with source, lifecycle, source metadata, failure count, and archive timestamp.
3. Extend proxy-backed accounts with egress lifecycle while preserving account ID and business configuration.
4. Add persisted proxy-sync run audit records with bounded history.
5. Add one atomic StateStore reconciliation operation that archives a failed proxy and binds a validated replacement to the same account.
6. Add state migration and stable-account replacement tests.

## Phase 2: Rola Source and Candidate Parsing

1. Add an isolated Rola source adapter for the current and daily HTML tables.
2. Parse columns by normalized header names so column order changes remain compatible.
3. Filter to public IPv4, valid ports, and HTTP/HTTPS/SOCKS4/SOCKS5.
4. Canonicalize URLs, deduplicate candidates, rank by availability, latency, and freshness.
5. Add parser fixtures for current/daily pages, malformed pages, reserved addresses, and protocol variants.

## Phase 3: Probe and Reconciliation Service

1. Add bounded candidate concurrency and per-stage abort timeouts.
2. Probe DeepInfra `/models/list` through the proxy.
3. Probe a minimal Kimi-K3 Chat through the same proxy with a fresh Turnstile ticket.
4. Check existing proxy-backed accounts and update transient failure counters.
5. Repair unavailable accounts before creating new capacity.
6. Atomically replace proxy bindings without changing account ID/configuration.
7. Create new stable accounts only until the configured target is reached.
8. Record redacted run audit details and notify the scheduler once.

## Phase 4: Admin API and Periodic Scheduling

1. Add status/settings/manual-run/run-history admin endpoints.
2. Add a Nitro plugin that schedules the first run after one full interval and skips overlapping runs.
3. Persist interrupted run status across restarts.
4. Add API tests for authorization, validation, mutual exclusion, and pagination.

## Phase 5: Admin UI

1. Add free-proxy sync controls to the proxy workspace.
2. Add target count, interval, concurrency, timeout, threshold, cooldown, and manual run controls.
3. Add latest-run metrics and proxy source/lifecycle indicators.
4. Keep existing manual import/check/delete workflows intact.

## Phase 6: Error Recovery and Verification

1. Reproduce current account assignment failures and classify local validation, transport, model capacity, rate limit, and upstream failures.
2. Ensure local input failures return 4xx and do not trigger account/proxy health changes.
3. Ensure transport failures enter proxy lifecycle; Model busy enters model cooldown only.
4. Run typecheck, full tests, and build.
5. Deploy with sync disabled, run one manual low-limit production sync, verify proxy/account stability and Chat, then enable periodic sync.
