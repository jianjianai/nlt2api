# Usage Analytics and Capacity Forecast Design

Date: 2026-08-23
Project: nlt2api
Status: Proposed for implementation

## Purpose

Add an auditable usage and cost ledger, total RPM visibility, per-model economics and utilization, and an explainable account-capacity forecast to the administration workspace. The feature must not affect request availability when analytics is degraded, must not retain message content or credentials, and must not infer false precision from incomplete historical records.

## Goals

1. Show current total upstream RPM, client RPM, upstream-call amplification, capacity utilization, and short-term trend.
2. Record exact post-launch token usage and estimated API-equivalent cost for every completed client execution.
3. Show total, time-range, and per-model consumption with input, cached-input, and output cost attribution.
4. Forecast additional model-capable accounts using observed demand, service duration, call amplification, account limits, model concurrency, health, and shared-egress constraints.
5. Explain every recommendation with the binding constraint, evidence windows, safety margin, and confidence.
6. Preserve exact historical cost under later price changes by freezing an immutable price snapshot on each execution.
7. Retain analytics indefinitely by default while allowing administrator-controlled retention and audited cleanup.

## Non-goals

- Automatically create accounts, purchase capacity, assign proxies, or modify scheduler settings.
- Reconstruct an exact bill for requests that predate this feature.
- Treat an API-equivalent estimate as the actual NeuralWatt invoice, subscription charge, credit balance, refund, or promotional allowance.
- Store prompts, responses, cookies, account credentials, API keys, or tool arguments in the analytics database.
- Apply approximate model-name mappings to vendor prices.
- Introduce an external metrics or time-series service for the current single-instance deployment.

## Established Facts

- Every Chat Completions and Responses request converges on `executeChatRequest()` exactly once at the client-execution boundary.
- Tool repair currently replaces the prior completion, so earlier repair-attempt usage is not represented by the final completion.
- Thinking continuation combines only top-level token totals; detailed cached and reasoning usage requires explicit per-attempt accumulation.
- Debug recording can be disabled and is capped and pruned. It cannot own billing data.
- Scheduler account RPM is shared across models. Model concurrency is per account and per model. Proxy RPM is shared by all accounts using the normalized egress.
- The scheduler currently keeps only per-process 60-second admission timestamps and an unclassified pending queue.
- The portal model catalog exposes `prompt_price_per_1k`, `completion_price_per_1k`, and nullable `cached_input_price_per_1k` for each exact portal model ID.
- Node 22.23.2 exposes `node:sqlite`; the deployed runtime was verified with SQLite 3.51.3. Access remains behind a repository-owned adapter because the Node API is still marked experimental.

## Ownership Boundaries

### `UsageAnalyticsService`

A new service owns the SQLite database, schema migrations, price versions, execution settlement, aggregate queries, retention, cleanup previews, cleanup audits, and forecast sample history. It is the only historical analytics owner.

The database lives under `NEURALWATT_DATA_DIR`, outside atomic application releases, and follows existing production data backup and restore boundaries. It uses WAL, foreign keys, a busy timeout, explicit transactions, and a monotonically versioned schema.

### Chat execution

`executeChatRequest()` owns one client execution ID and the final settlement call. Every real portal attempt reports its usage, model, account, attempt type, sequence, timing, and outcome into an in-memory execution accumulator. Initial, repair, continuation, and retry attempts are additive. The outer execution boundary submits one idempotent transaction on success or terminal failure.

`consumedCompletionTokens()` is a continuation-loop guard only and must never feed billing.

### Scheduler

`account-scheduler.ts` remains the owner of admission and capacity facts. It classifies model demand, admission, waiting, rejection, service completion, and blocking constraints. It sends bounded analytics events and exposes the current unified forecast snapshot. The frontend never derives account requirements from raw account cards.

### Administration API and UI

The administration status/analytics API returns server-owned aggregates and forecast conclusions. Vue components format and display the values but do not calculate prices, capacities, account deficits, or confidence.

## Storage Architecture

Use SQLite WAL through a small `AnalyticsDatabase` adapter around `node:sqlite`. The adapter owns connection options, statements, transactions, migrations, test isolation, and shutdown. No other module imports `node:sqlite`.

### Core tables

#### `schema_migrations`

Stores applied integer migration versions and timestamps.

#### `price_versions`

Immutable price rows:

- `id`
- exact `model_id`
- provider and display name
- source type: `vendor_official` or `portal_catalog`
- source URL
- source/model version identifier
- currency
- input, cached-input, and output price in integer nano-USD per token
- optional rule metadata for supported dynamic or tiered pricing
- effective time, fetched time, verified time
- raw-source SHA-256 and normalized rule JSON

A newer row supersedes future matching only. Existing executions continue to reference their original row.

#### `executions`

One immutable settlement per client execution:

- unique execution ID
- client endpoint and requested model
- final account ID where meaningful, without credentials
- started/completed timestamps and duration
- client outcome/status
- total real upstream attempts and attempt amplification
- prompt, cached prompt, completion, reasoning, and total tokens
- priced and unpriced token counts
- price-version ID and source type
- input, cached-input, output, and total integer micro-USD
- settlement status and created timestamp

No request or response bodies are stored.

#### `execution_attempts`

One row per real portal call, keyed by execution ID and attempt sequence:

- attempt type: initial, repair, continuation, retry
- model and account ID
- egress identity hash, not credential-bearing URL
- admitted, started, and completed timestamps
- outcome/status and duration
- token usage details

These rows make amplification, duration, repair cost, and settlement auditable.

#### `minute_buckets`

Per UTC minute and model:

- client demand, admitted, queued, rejected, succeeded, failed
- upstream attempts
- duration samples summarized for percentile calculation
- token and cost totals
- account and egress binding-constraint counts

Unique keys make bucket updates idempotent.

#### `daily_model_totals` and `monthly_model_totals`

Immutable/monotonic rollups preserve long-range model usage and cost after high-frequency data cleanup.

#### `forecast_snapshots`

Stores model, calculated time, observed windows, forecast demand, effective capacity, utilization, recommended account delta, binding constraint, confidence, sample coverage, and safety margin. These support audit and UI trend explanations.

#### `analytics_failures`

A bounded compensation queue for settlement writes that failed after the client result was determined. It contains execution ID, body-free normalized settlement payload, attempts, next retry, and last error.

#### `cleanup_audit`

Stores administrator, requested cutoff/range, preview counts, completed counts, released-page estimate, aggregate checksums before and after cleanup, and timestamp.

## Exact Usage Settlement

### Execution identity and idempotency

Generate one execution UUID at the outer `executeChatRequest()` boundary. Attempt sequences are deterministic within the execution. Settlement is a single transaction with unique constraints on execution ID and `(execution_id, sequence)`. Repeating the same settlement is a no-op after payload-hash equality validation; a conflicting duplicate raises an analytics alert instead of altering the ledger.

### Attempt accumulation

Every `getCompletion()` result contributes its usage before later control flow can replace that completion. The accumulator sums:

- prompt tokens
- cached prompt tokens
- completion tokens
- reasoning tokens when supplied
- total tokens
- attempt count and duration

Cached prompt tokens are a subset of prompt tokens. Charge cached tokens at the cached rate and only `prompt - cached` at the standard input rate. Never double-charge the cache-hit portion.

If an upstream attempt lacks usage, retain the attempt with `usage_missing=true`. Do not estimate token usage from text length. The execution exposes priced coverage and missing-usage counts.

### Success and failure

Successful and terminal failed executions are both recorded. Cost uses actual reported tokens, including failed attempts that consumed tokens. Aborted requests record attempts already completed; an in-progress upstream call without terminal usage remains unpriced rather than estimated.

Analytics persistence happens after the client result is determined. A write failure must not convert a successful gateway result to failure. It creates a high-priority analytics anomaly and a body-free compensation entry for retry.

## Pricing Policy

### Authority order

1. Use a vendor-official price only when the exact client/portal model ID equals a verified official API ID and the published pricing rule can be evaluated from known call metadata.
2. Otherwise use the exact NeuralWatt portal catalog row for that model ID.
3. If neither source provides a valid row, mark the execution unpriced. Continue counting requests and tokens, but exclude it from the priced total and show unpriced coverage explicitly.

No fuzzy matching, suffix stripping, provider-family matching, or inferred Gemma/Gemini substitution is allowed.

### Price refresh

- Load reviewed built-in vendor price versions at startup.
- Fetch the portal catalog at startup and every 24 hours.
- Provide an authenticated manual refresh operation.
- Validate exact fields, non-negative values, currency, and duplicate IDs before activation.
- Keep the last valid catalog if refresh fails and expose stale age/status.

Each execution freezes its selected price-version ID. Historical costs are never recalculated merely because prices change. A confirmed historical correction creates an explicit adjustment ledger entry referencing the original execution and correction reason.

### Monetary precision

Normalize prices to integer nano-USD per token and execution charges to integer micro-USD using deterministic rounding. Aggregates sum integers. UI formatting never feeds persisted values.

The default display currency is USD. No live exchange-rate conversion is introduced.

## Demand and Capacity Signals

Scheduler events are recorded per model:

- demand arrival
- admission and selected account/egress
- queue entry and wait duration
- queue timeout/full rejection
- impossible demand because no enabled/model-capable/session-valid account exists
- release with service duration and outcome
- binding constraint observed during blocked decisions

Binding constraints are typed:

- `account_rpm`
- `model_concurrency`
- `shared_egress_rpm`
- `no_healthy_account`
- `model_cooldown`
- `account_cooldown`
- `queue_policy`
- `insufficient_samples`

The event path is bounded and asynchronous. Analytics backpressure cannot block scheduler admission.

## Forecast Model

### Demand forecast

For each model, compute 5-, 15-, and 60-minute EWMA demand from minute buckets. Use the 5-to-15-minute slope to adjust the 15-minute baseline, constrained by the 60-minute baseline to reduce one-minute spikes. Apply a 20% safety margin.

Persist the exact inputs and formula version in each forecast snapshot.

### Concurrency conversion

Use model P95 observed service duration with Little's law to convert each account-model concurrency limit to sustainable RPM:

`concurrency_rpm = model_concurrency * 60_000 / p95_duration_ms`

Require a minimum sample threshold. With insufficient duration samples, use a conservative configured fallback and mark confidence low.

### Call amplification

Compute P95 upstream attempts per client execution by model. Divide upstream-limited capacity by this amplification when comparing it with client demand. Repairs, continuations, and retries therefore reduce effective capacity instead of disappearing from the forecast.

### Feasible capacity

Capacity is not `demand / global_account_rpm`. Account RPM is shared across models, model concurrency is per account/model, and egress RPM is shared across accounts. Use a deterministic capacity-allocation solver over enabled, session-valid, non-cooled accounts and their model coverage:

- account total assigned RPM cannot exceed its effective account RPM
- account-model assigned RPM cannot exceed its P95-duration concurrency RPM
- all accounts on an egress cannot exceed effective egress RPM
- each model's assigned capacity is measured against forecast demand

The solver maximizes covered forecast demand, then calculates the minimum additional model-capable account templates needed to cover residual demand without double-counting accounts shared across models.

### Recommendation behavior

A recommendation contains:

- target model or model set
- forecast client RPM
- current effective client RPM capacity
- safety-adjusted deficit
- recommended additional accounts
- binding constraint
- confidence: high, medium, or low
- sample minutes and P95 sample count
- expected time to the safety threshold when trend is positive

If shared egress is binding, recommend a new independent egress and set additional accounts to zero until egress capacity exists. If samples are insufficient, show observed load and a low-confidence state without a strong account-count recommendation.

Use hysteresis: require sustained pressure before raising a recommendation and sustained recovery before clearing it. The feature never changes configuration automatically.

## Administration API

Extend the authenticated administration surface with a bounded analytics response rather than returning execution rows from the general status endpoint.

### Overview summary

Returns:

- ledger start time and price-catalog status
- current client and upstream RPM
- 5/15/60-minute trend and amplification
- capacity utilization
- today/month priced cost and priced coverage
- unpriced request/token counts
- top forecast recommendation and current anomalies
- compact 60-minute series

### Analytics query

An authenticated endpoint accepts validated range, granularity, sort, and model filters. It returns bounded time series and per-model rows with requests, client/upstream RPM, amplification, token breakdown, cost breakdown, effective capacity, utilization, and recommendation.

### Price refresh and retention

Authenticated mutation endpoints support manual price refresh, retention update, cleanup preview, and confirmed cleanup. Cleanup requires a preview token tied to the range and current database state so a stale confirmation cannot delete a different set.

## Administration UI

Use the approved **trend-first** layout within `OverviewWorkspace.vue`.

### First viewport

- A total upstream RPM spotlight with client RPM, amplification, 15-minute change, and a compact 60-minute chart.
- Compact metrics for capacity utilization, today's priced cost, recommended accounts/action, and month cost.
- A persistent top forecast callout with model, number/action, binding constraint, time-to-threshold, safety margin, and confidence.

### Analysis views

A page-local control switches only the lower analysis region between:

1. `Capacity forecast`: forecast/effective-capacity comparison, constraints, confidence, and evidence.
2. `Cost analysis`: today, month, and custom range; input/cache/output cost; priced coverage; catalog source and stale state.
3. `Model utilization`: sortable model table with client RPM, upstream RPM, amplification, tokens, cost, capacity, utilization, and account recommendation.

The top live conclusion stays visible when switching views.

### Existing operations

Keep `Needs attention`, account load, and egress runtime below the analytics region. Capacity alerts enter `Needs attention` with direct navigation to the relevant account, scheduler, or egress workspace.

### States and accessibility

Provide explicit states for no post-launch data, loading, low confidence, partial/missing pricing, stale pricing, analytics database degradation, and empty model filters. Use semantic headings, buttons, tables, status text in addition to color, keyboard-visible focus, 44px mobile controls, reduced motion, and no horizontal page scroll at 320px.

## Retention and Cleanup

Default all analytics data to permanent retention. Administrators may independently configure execution-detail and minute-bucket retention in days or leave either permanent.

Manual cleanup flow:

1. Select data classes and a cutoff/range.
2. Preview exact row counts, time range, and estimated reclaimable pages.
3. Require explicit confirmation using a short-lived preview token.
4. Materialize/check daily and monthly rollups for the affected range.
5. Delete selected details in a transaction and checkpoint/vacuum only when operationally appropriate.
6. Verify aggregate count/token/cost checksums are unchanged.
7. Persist a cleanup audit row.

Price versions referenced by preserved aggregates, adjustment records, cleanup audits, and daily/monthly totals are permanent. Cleanup cannot alter historical total cost.

## Failure Handling

- SQLite unavailable: keep gateway and scheduler operational, expose analytics degraded status, and retry initialization with bounded backoff.
- Settlement write failure: enqueue body-free compensation payload; show an urgent anomaly; idempotently retry.
- Price fetch/validation failure: keep last valid price version and expose stale age.
- Missing price: record usage as unpriced; never silently use zero.
- Missing usage: record attempt and coverage gap; never estimate from content.
- Forecast solver failure: return current raw load with `forecast_unavailable`; do not emit an account number.
- Cleanup checksum mismatch: rollback the deletion and report failure.

## Security and Privacy

- All analytics and retention endpoints require the administrator token.
- The analytics database contains no prompts, responses, tool data, passwords, API keys, cookies, or full credential-bearing proxy URLs.
- Account IDs and normalized egress hashes are operational identifiers; UI uses existing labels where authorized.
- Source URLs and price rows are public metadata. Raw portal responses are not retained beyond a normalized price version and SHA-256.
- Cleanup and price refresh operations are audited.

## Verification Strategy

### Exact settlement

- Non-streaming and streaming requests settle once.
- Initial, repair, continuation, and retry attempts all contribute usage and duration.
- Cached input is not double charged.
- Missing usage remains visible and unpriced.
- Duplicate settlement is a no-op; conflicting duplicate is an anomaly.
- Price changes do not alter historical execution cost.

### Forecast

- Minute window boundaries and EWMA/trend calculations.
- P95 duration and call-amplification effects.
- Shared account RPM across models.
- Per-account/per-model concurrency.
- Shared egress saturation recommends egress, not accounts.
- Mixed account model coverage avoids duplicate account counts.
- Health/cooldown/session exclusions.
- Low-sample fallback, confidence, and hysteresis.

### Storage and lifecycle

- Empty database migration and upgrade migration.
- Restart persistence and WAL behavior.
- Concurrent read with serialized settlement writes.
- Compensation retry and idempotency.
- Cleanup preview token invalidation.
- Cleanup preserves daily/monthly aggregate checksums and price references.

### UI and API

- Validated bounded ranges and model filters.
- Trend-first desktop layout and 320px/390px responsive behavior.
- Keyboard operation, focus visibility, table semantics, and non-color status text.
- Loading, empty, stale, unpriced, low-confidence, and degraded states.
- Existing account, proxy, scheduler, record, and settings workflows remain unchanged.

## Deployment and Rollback

1. Back up the existing data directory and current atomic release.
2. Deploy code with the database migration disabled until preflight verifies the writable data directory and Node 22.23.2 SQLite support.
3. Initialize the database and built-in price versions; fetch and validate the portal catalog.
4. Start exact ledger collection. Record and display this timestamp as the analytics boundary; do not import old debug records.
5. Enable overview analytics after the first successful summary query.
6. Verify health, authentication, an exact non-stream request, an exact stream request, ledger settlement, price source, total RPM, and forecast low-sample state.
7. Rollback code by switching the atomic release. Preserve the analytics database; older code ignores it. Never delete or downgrade the ledger during application rollback.

## Acceptance Criteria

- The overview shows total upstream RPM, client RPM, amplification, capacity utilization, a 60-minute trend, today/month cost, and a model-specific capacity recommendation or an explicit reason no recommendation is available.
- Every post-launch client execution settles at most once and includes every completed upstream attempt.
- Historical execution cost references an immutable exact-ID price version with visible source; unpriced usage is explicit.
- Forecast recommendations account for shared account RPM, model concurrency, shared egress RPM, health, P95 duration, and P95 call amplification.
- Shared-egress saturation never produces a misleading account-only recommendation.
- The per-model view provides RPM, amplification, tokens, cost, effective capacity, utilization, and recommended accounts.
- Default retention is permanent; configurable retention and manual cleanup preserve historical aggregate cost and produce an audit record.
- Analytics degradation never prevents normal gateway requests, while the administration UI reports the degradation.
- No pre-feature request is presented as exact historical cost.
