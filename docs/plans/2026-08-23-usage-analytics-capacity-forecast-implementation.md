# Usage Analytics and Capacity Forecast Implementation Plan

## Source Design

Implement `docs/designs/2026-08-23-usage-analytics-capacity-forecast-design.md` exactly as approved. Preserve unrelated local changes in every touched file.

The implementation has three strict owners:

- `UsageAnalyticsService` owns historical usage, price versions, aggregates, retention, and cleanup.
- `AccountScheduler` owns admission facts and the current capacity forecast inputs.
- `App.vue` owns authenticated frontend loading and mutations. Workspace components render typed state and emit actions only.

Do not import old debug records, store message content, fuzzy-match model IDs, or let analytics failures fail gateway requests.

## Phase 1: SQLite Adapter, Schema, and Price Catalog

### Files

- `server/utils/analytics-database.ts` (new)
- `server/utils/analytics-types.ts` (new)
- `server/utils/model-pricing.ts` (new)
- `server/utils/usage-analytics.ts` (new)
- `server/utils/portal-client.ts`
- `tests/analytics-database.test.ts` (new)
- `tests/model-pricing.test.ts` (new)
- `package.json`

### Changes

1. Add an `AnalyticsDatabase` adapter as the only module allowed to import `node:sqlite`.
2. Resolve `usage-analytics.sqlite` under `NEURALWATT_DATA_DIR`; initialize the directory without changing the existing account/debug store.
3. Configure `journal_mode=WAL`, `foreign_keys=ON`, a bounded `busy_timeout`, restrictive file permissions where supported, and explicit close/reset hooks for tests.
4. Implement monotonic schema migrations for:
   - `schema_migrations`.
   - `price_versions`.
   - `executions` and `execution_attempts`.
   - `minute_buckets`, `daily_model_totals`, and `monthly_model_totals`.
   - `forecast_snapshots`.
   - `analytics_settings` for independent detail/minute retention.
   - `analytics_failures` and `cleanup_audit`.
5. Store monetary values as integer nano-USD per token and micro-USD per execution. Add checked conversion helpers that reject negative, non-finite, or unsafe integer values.
6. Define body-free types for attempt usage, execution settlement, price source/status, aggregates, forecast snapshots, retention, cleanup preview, and analytics health.
7. Extend `PortalClient.listModels()` with a typed validated catalog projection containing exact model ID, provider, display name, and the three observed portal price fields. Keep raw catalog objects out of analytics callers.
8. Implement exact-ID price selection:
   - Reviewed built-in vendor rows only for exact official API IDs.
   - Exact portal row fallback for every other portal ID.
   - Explicit unpriced result when neither row is valid.
9. Persist immutable price versions by normalized content hash. Updating the catalog creates a new future version without mutating rows referenced by executions.
10. Add startup and manual refresh methods. Refresh failure keeps the last valid catalog and records stale/error metadata.
11. Add focused tests with temporary data directories for migrations, restart persistence, WAL configuration, integer precision, invalid catalog rejection, exact-ID selection, portal fallback, unpriced models, and immutable versioning.
12. Add the two new test files to the existing `pnpm test` script.

### Verification

Run:

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/analytics-database.test.ts tests/model-pricing.test.ts
```

Done when a fresh and reopened database returns the same immutable price rows and all matching rules remain exact-ID only.

## Phase 2: Per-Attempt Usage Capture and Idempotent Settlement

### Files

- `server/utils/types.ts`
- `server/utils/chat-service.ts`
- `server/utils/upstream-stream.ts`
- `server/utils/usage-analytics.ts`
- `server/utils/analytics-types.ts`
- `server/routes/v1/chat/completions.post.ts` only if endpoint identity is not already available at the execution boundary
- `server/routes/v1/responses.post.ts` only if endpoint identity is not already available at the execution boundary
- `tests/usage-analytics.test.ts` (new)
- `tests/core.test.ts`
- `tests/chat-validation.test.ts`
- `tests/response-api.test.ts`
- `package.json`

### Changes

1. Expand `UpstreamUsage` to type cached prompt tokens and upstream reasoning-token details without weakening existing JSON compatibility.
2. Add an execution-scoped accumulator created once by `executeChatRequest()` with a UUID, endpoint/model identity, start time, deterministic attempt sequence, and no message content.
3. Instrument every real `portalClient.requestChat()` attempt inside `getCompletion()`:
   - Capture admission, start/end time, account ID, sanitized egress identity hash, retry/initial/repair/continuation type, status/outcome, and terminal usage.
   - Include retries initiated inside `PortalClient.requestChat()` by exposing attempt lifecycle callbacks rather than inferring retries from debug records.
   - Record completed attempts before later repair or continuation logic replaces `result.completion`.
4. Parse terminal stream usage and any structured reasoning-token details. Do not use SSE pricing comments as a billing authority; retain them only as optional diagnostic metadata if already available.
5. Replace the partial `addUsageTotals()` behavior with one tested detailed-usage accumulator used by continuation output and settlement.
6. Ensure tool repair adds every failed candidate and repair result to the same execution accumulator.
7. Settle once in the outer `executeChatRequest()` `finally`/terminal path for success, upstream failure, abort, or validation-reached execution failure. Validation failures that never begin an execution do not create usage rows.
8. Charge `prompt_tokens - cached_tokens` at standard input price, cached tokens at cached price when present, and completion tokens at output price. Preserve missing usage and missing price as explicit coverage gaps.
9. Use a transaction and unique execution/attempt keys. Equal duplicate payloads are no-ops; conflicting duplicate hashes create an analytics anomaly and never rewrite history.
10. Keep response delivery independent from settlement persistence. On write failure, enqueue a normalized body-free compensation payload and schedule bounded idempotent retries.
11. Expose a test-only analytics dependency/reset hook so request tests never write the production data directory.
12. Add tests covering non-stream, stream, portal retry, tool repair, thinking continuation, cached input, reasoning details, terminal failure, abort-after-completed-attempt, missing usage, unpriced usage, duplicate settlement, conflicting duplicate, and compensation retry.
13. Add `tests/usage-analytics.test.ts` to `pnpm test`.

### Verification

Run:

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/usage-analytics.test.ts tests/chat-validation.test.ts tests/response-api.test.ts
```

Done when each client execution has at most one immutable settlement and its attempt rows exactly equal the real upstream calls made by repair, continuation, retry, and normal paths.

## Phase 3: Scheduler Demand Signals and Capacity Forecast

### Files

- `server/utils/account-scheduler.ts`
- `server/utils/capacity-forecast.ts` (new)
- `server/utils/analytics-types.ts`
- `server/utils/usage-analytics.ts`
- `server/utils/types.ts`
- `tests/account-scheduler.test.ts`
- `tests/capacity-forecast.test.ts` (new)
- `package.json`

### Changes

1. Add a bounded analytics event sink to scheduler dependencies so deterministic tests can inspect signals without opening SQLite.
2. Record model demand at `acquire()` before queue processing, then emit admitted, queued, rejected, impossible, released, and observed binding-constraint events.
3. Extend internal blocked results with typed reasons:
   - account RPM.
   - model concurrency.
   - shared egress RPM.
   - no healthy/model-capable account.
   - model/account cooldown.
   - queue policy.
4. Preserve the scheduler's current admission behavior and wake-up semantics. Observation must not reserve capacity twice, change candidate ranking, or await analytics I/O.
5. Extend `AccountLease` with immutable model, account, egress, admitted-at, and release outcome/duration observation while keeping release idempotent.
6. Bucket demand and outcomes per UTC minute/model in `UsageAnalyticsService`; keep the event queue bounded and report dropped-sample health without blocking admission.
7. Implement pure forecast helpers for:
   - 5/15/60-minute EWMA.
   - bounded short-term trend.
   - 20% safety margin.
   - percentile calculation with minimum sample thresholds.
   - P95 service-duration concurrency-to-RPM conversion.
   - P95 upstream-call amplification.
   - confidence and hysteresis.
8. Implement a deterministic feasible-capacity solver over current enabled/session-valid/non-cooled accounts, exact model coverage, shared account RPM, per-account/model concurrency RPM, and shared egress RPM.
9. Calculate the minimum additional model-capable account templates without summing overlapping model deficits twice.
10. When shared egress is binding, return an egress recommendation and zero additional accounts. With insufficient samples, return low confidence without a strong account number.
11. Extend `SchedulerRuntimeSnapshot` with server-computed total client/upstream RPM, utilization, model capacity rows, top recommendation, constraint evidence, and confidence. Do not expose proxy credentials.
12. Persist forecast snapshots with formula version and all evidence inputs used by the decision.
13. Add deterministic fake-clock tests for event classification, exact minute boundaries, EWMA/trend, P95, amplification, shared account RPM, model concurrency, mixed coverage, shared egress, cooldown/session exclusions, low samples, and hysteresis.
14. Add `tests/capacity-forecast.test.ts` to `pnpm test`.

### Verification

Run:

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/account-scheduler.test.ts tests/capacity-forecast.test.ts
```

Done when every forecast count is reproducible from persisted evidence and shared-egress saturation never recommends adding accounts alone.

## Phase 4: Authenticated Analytics and Lifecycle API

### Files

- `server/api/admin/status.get.ts`
- `server/api/admin/analytics.get.ts` (new)
- `server/api/admin/analytics/prices/refresh.post.ts` (new)
- `server/api/admin/analytics/retention.patch.ts` (new)
- `server/api/admin/analytics/cleanup/preview.post.ts` (new)
- `server/api/admin/analytics/cleanup.post.ts` (new)
- `server/utils/usage-analytics.ts`
- `server/utils/http.ts` only if a reusable bounded date/range parser is needed
- `tests/analytics-api.test.ts` (new)
- `tests/analytics-database.test.ts`
- `package.json`

### Changes

1. Add a compact analytics overview to `/api/admin/status`:
   - Ledger start and health.
   - Price freshness/source coverage.
   - Current client/upstream RPM and amplification.
   - 5/15/60-minute trend.
   - Utilization and top forecast.
   - Today/month priced cost and unpriced coverage.
   - Bounded 60-minute series and active analytics anomalies.
2. Keep detailed range/model/granularity queries in `/api/admin/analytics` so auto-refresh does not pull execution rows or unbounded series.
3. Validate range, timezone handling, granularity, model filter, sort field/direction, and result bounds server-side. Return model aggregates only, never execution bodies or credential-bearing fields.
4. Add authenticated manual price refresh with typed current/stale/failure result.
5. Persist retention preferences in `analytics_settings`, independent of gateway `ProxySettings`, with permanent retention as the default.
6. Implement cleanup preview with exact data classes, cutoff/range, row counts, covered time, estimated reclaimable pages, aggregate checksums, and a short-lived state-bound preview token.
7. Implement confirmed cleanup:
   - Reject stale/altered preview tokens.
   - Materialize and verify daily/monthly rollups.
   - Delete selected execution/attempt or minute rows transactionally.
   - Verify aggregate request/token/cost checksums are unchanged.
   - Persist cleanup audit.
   - Leave price versions and historical totals intact.
8. Keep SQLite/forecast errors localized: status returns a typed degraded analytics object while accounts, scheduler, proxies, settings, and config continue loading.
9. Require administrator authentication on every new endpoint and preserve existing OpenAI-compatible error formatting.
10. Add API tests for unauthorized access, query bounds, malformed dates/models/sorts, compact status payload, degraded status, refresh result, retention persistence, cleanup preview, stale token, successful cleanup, and checksum rollback.
11. Add `tests/analytics-api.test.ts` to `pnpm test`.

### Verification

Run:

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/analytics-api.test.ts tests/analytics-database.test.ts
```

Done when authenticated APIs return bounded server-owned calculations and cleanup cannot change preserved historical cost.

## Phase 5: Trend-First Overview and Analytics Controls

### Files

- `app/types/admin.ts`
- `app/App.vue`
- `app/utils/admin-ui.ts`
- `app/components/OverviewWorkspace.vue`
- `app/components/GatewaySettingsWorkspace.vue`
- `app/components/ui/AppIcon.vue` only if an approved icon is absent
- `app/assets/workspace.css`
- `app/assets/theme.css` only for shared semantic tokens that do not already exist
- `tests/admin-ui.test.ts`

### Changes

1. Add typed frontend contracts for compact analytics overview, time series, per-model rows, forecast evidence, pricing status, retention, cleanup preview/result, and degraded states.
2. Keep `loadDashboard()` as the single auto-refresh owner. Read the compact analytics object from `/api/admin/status` and preserve the previous usable analytics snapshot during a transient degraded refresh while displaying staleness.
3. Keep detailed analytics fetches and all mutations in `App.vue`; use request sequence IDs or abort controllers so stale range/filter responses cannot overwrite newer selections.
4. Replace frontend-derived traffic metrics with server-owned total upstream/client RPM, amplification, utilization, and forecast. Retain `deriveOverview()` only for existing account/proxy/action conditions and accept server analytics actions as typed inputs.
5. Implement the approved trend-first first viewport:
   - Total upstream RPM spotlight.
   - Client RPM and amplification.
   - 60-minute SVG/CSS chart using actual series data, accessible text summary, and reduced-motion behavior.
   - Compact utilization, today cost, account/egress recommendation, and month cost metrics.
   - Persistent top forecast callout with binding constraint, confidence, safety margin, and time to threshold.
6. Add page-local segmented views for 「容量预测」, 「消费分析」, and 「模型利用率」. Switching views affects only the lower analytics region.
7. Add cost range controls for today, month, and custom bounded dates. Show input/cache/output cost, priced coverage, unpriced requests/tokens, ledger start, source, and stale catalog state.
8. Add a sortable model table for client/upstream RPM, amplification, tokens, cost, effective capacity, utilization, and recommendation. Keep model IDs readable and stable at 320px without horizontal page overflow.
9. Preserve existing 「需要处理」, account load, and egress sections. Add forecast/analytics anomalies with direct navigation to accounts, scheduler, proxies, or settings.
10. Add an 「分析数据」 section to `GatewaySettingsWorkspace.vue` for:
    - Ledger/price status.
    - Independent permanent/day retention controls.
    - Manual price refresh.
    - Cleanup date/data-class selection.
    - Preview result and explicit second confirmation using existing dialog patterns.
11. Preserve `GatewaySettingsWorkspace.vue` as a presentation/emission boundary. It must not call APIs or own persisted settings.
12. Implement explicit loading, no post-launch data, low confidence, stale price, partial/unpriced, degraded database, cleanup preview, cleanup progress, and mutation error states.
13. Extend pure admin UI tests for formatting integer micro-USD, trend direction, action derivation, coverage labels, forecast constraint labels, and stable range defaults.
14. Reuse existing controls, icons, focus rules, spacing, card radii, and responsive conventions. Do not add nested cards, decorative gradients, or a frontend state library.

### Verification

Run:

```powershell
corepack pnpm typecheck
```

Done when the complete frontend contract typechecks and no component owns pricing, forecasting, persistence, or direct authenticated requests.

## Phase 6: Integrated Regression, Operational Verification, and Documentation

### Files

- `README.md`
- `docs/upstream-capability.md`
- Existing tests only where failures prove a changed boundary is uncovered
- Deployment scripts/config only if the approved deployment step requires an explicit data backup/preflight addition

### Changes

1. Document:
   - Analytics database location and Node 22 requirement.
   - Ledger start boundary and no historical debug-record import.
   - API-equivalent estimate versus actual portal billing.
   - Exact vendor/portal/unpriced price authority.
   - RPM, amplification, utilization, confidence, and binding-constraint definitions.
   - Permanent defaults, retention controls, cleanup invariants, backup, and restore.
   - Analytics-degraded behavior and compensation queue.
2. Record the observed NeuralWatt catalog price fields in `docs/upstream-capability.md` without freezing current numeric prices into a timeless contract.
3. Run the repository's existing complete test command once after all focused phases pass.
4. Build once because the change adds new server modules/routes and Vue component contracts across the application boundary.
5. Start the existing local development server at its printed Local URL and inspect the authenticated page at wide desktop, 768px, 390px, and 320px:
   - No-data ledger start.
   - Live RPM trend.
   - High/low-confidence forecasts.
   - Shared-egress recommendation.
   - Priced, partial-unpriced, stale, and degraded states.
   - Cost/model sorting and custom range races.
   - Retention save, cleanup preview, confirmation, cancellation, and focus restoration.
6. Confirm no prompt/response/account secret/full proxy URL is present in SQLite or analytics API payloads.
7. Before production deployment:
   - Back up `NEURALWATT_DATA_DIR` and the current atomic release.
   - Verify writable data directory and `node:sqlite` under Node 22.23.2.
   - Initialize/migrate SQLite and validate the portal price catalog.
   - Record the exact ledger start timestamp.
8. Deploy only after explicit deployment authorization. Verify health, authenticated/unauthenticated admin boundaries, one non-stream request, one stream request, one settlement per request, price source, total RPM, low-sample forecast state, and overview rendering.
9. Rollback application code through the existing atomic release mechanism without deleting or downgrading `usage-analytics.sqlite`.

### Final Verification

Run:

```powershell
corepack pnpm test
corepack pnpm build
```

Then perform the one authenticated browser acceptance pass described above. Stop after these checks pass; do not add unrelated lint or infrastructure work.

Done when the accepted UI and APIs display server-owned exact post-launch usage, immutable price-backed cost, explainable model capacity, configurable permanent retention, and safe cleanup without changing existing gateway behavior.
