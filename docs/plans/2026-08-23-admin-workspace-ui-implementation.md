# Admin Workspace UI Implementation Plan

## Source Design

Implement `docs/designs/2026-08-23-admin-workspace-ui-design.md` exactly as approved.

Preserve all existing server APIs and runtime behavior. `App.vue` remains the only owner of authenticated data loading and mutations during this refactor. Workspace components receive typed state and callbacks; they do not independently duplicate server synchronization.

## Phase 1: Shared Frontend Contracts and State Helpers

### Files

- `app/types/admin.ts` (new)
- `app/utils/admin-ui.ts` (new)
- `app/App.vue`
- `tests/admin-ui.test.ts` (new, only for pure helpers)
- `package.json`

### Changes

1. Move current frontend-only interfaces from `App.vue` into `app/types/admin.ts`:
   - Account and runtime types.
   - Scheduler settings/runtime.
   - Proxy-pool settings/entries/import results.
   - Debug-record list/detail types.
   - Gateway settings/config payload types.
   - Workspace ID union.
2. Add pure helpers in `app/utils/admin-ui.ts` for:
   - Workspace persistence validation.
   - Proxy/account status labels and tones.
   - Overview metric and action-item derivation.
   - Proxy policy summary text.
   - Safe last-workspace storage keys.
3. Keep helpers free of DOM, Vue and network dependencies so the existing Node test harness can cover them.
4. Add focused tests proving:
   - Invalid persisted workspaces fall back to Overview.
   - Cooling/model-cooling/error-proxy/queue/API-key action items derive only from current payload fields.
   - Counts and labels remain deterministic.
5. Add `tests/admin-ui.test.ts` to the existing `pnpm test` command.

### Verification

```powershell
node --experimental-transform-types --import ./tests/register-alias.mjs --test tests/admin-ui.test.ts
corepack pnpm typecheck
```

Done when frontend contracts compile outside the monolithic component and pure overview/state logic is fixed by tests.

## Phase 2: Workspace Shell and Navigation

### Files

- `app/components/WorkspaceShell.vue` (new)
- `app/components/ui/WorkspaceIcon.vue` (new only if CSS/text symbols cannot meet accessible naming cleanly)
- `app/App.vue`
- `app/assets/main.css`

### Changes

1. Build the desktop shell:
   - Sticky top status bar.
   - Persistent left rail for Overview, Accounts, Proxy Pool, Scheduler and Request Records.
   - Gateway Settings pinned to the rail footer.
   - Main workspace region with one active page.
2. Build mobile adaptation:
   - Bottom navigation for the five operational workspaces.
   - Settings action in the mobile top bar.
   - Safe-area-aware content padding.
3. Add last-workspace persistence:
   - First authenticated session opens Overview.
   - Later sessions restore a validated workspace ID.
   - Sign-out preserves workspace preference but clears sensitive/open state.
4. Add active-location semantics (`aria-current`) and accessible labels.
5. Remove the old top-tab navigation only after all existing content remains reachable through the new shell.
6. Normalize high-level tokens in `main.css`:
   - Chinese UI font and mono font.
   - Four-pixel spacing scale.
   - Six/eight-pixel radii.
   - Cool neutral surfaces, deep navy ink and teal accent.
   - Shared focus-visible, pressed, disabled and reduced-motion rules.

### Verification

```powershell
corepack pnpm typecheck
corepack pnpm build
```

Browser-check navigation at 320px, 390px, 768px and wide desktop. Done when every existing page remains reachable, the last workspace restores correctly and no navigation covers content.

## Phase 3: Overview Workspace

### Files

- `app/components/OverviewWorkspace.vue` (new)
- `app/App.vue`
- `app/assets/main.css`
- `app/utils/admin-ui.ts`
- `tests/admin-ui.test.ts`

### Changes

1. Render compact overview metrics from existing status state:
   - Enabled/total accounts.
   - Healthy/total proxies.
   - In-flight and pending requests.
   - Error proxies and cooling accounts.
2. Render bounded action-required items for:
   - Error proxies.
   - Cooling accounts.
   - Model cooldowns.
   - Queue backlog/old wait.
   - Missing client API key.
3. Wire actions to existing functions or workspace navigation:
   - Check proxy.
   - Expand/view account.
   - Open Scheduler.
   - Open Gateway Settings.
4. Add compact account-load and egress summaries without configuration fields.
5. Add loading and no-action-required states.

### Verification

Run focused helper tests, typecheck and build. Browser-check healthy, cooling, error-proxy and non-zero-queue payloads. Done when Overview shows only evidence-backed conditions and every action reaches the owning workspace.

## Phase 4: Accounts Workspace and Secret Values

### Files

- `app/components/AccountsWorkspace.vue` (new)
- `app/components/ui/SecretValue.vue` (new)
- `app/App.vue`
- `app/assets/main.css`

### Changes

1. Migrate account search, status presentation and card markup into `AccountsWorkspace.vue`.
2. Replace the large always-expanded account cards with compact runtime cards showing:
   - Label/email.
   - Status/session.
   - Egress/pool state.
   - RPM/in-flight/next availability.
   - Model count.
   - Manage action.
3. Allow one inline expanded account at a time.
4. Group expanded content into Credentials, Egress, Models and Limits while reusing current callbacks:
   - Verify.
   - Edit/clear proxy.
   - Assign proxy from pool.
   - Refresh/edit models.
   - Edit scheduler overrides.
   - Enable/disable.
   - Delete.
5. Keep existing modal data and save functions in `App.vue` during this phase; pass callbacks and busy IDs as props.
6. Implement `SecretValue.vue`:
   - Mask by default.
   - Show/hide.
   - 30-second auto-hide.
   - Copy without persistent reveal.
   - Re-mask on blur, workspace switch and sign-out via parent-controlled reset token.
   - Accessible button labels and status announcement.
7. Use `SecretValue` for account passwords. Do not expose full proxy credentials because the current proxy-pool APIs remain masked.
8. Add explicit loading labels to account actions and maintain duplicate-submit guards.

### Verification

Typecheck/build. Browser-check 0, 1 and many accounts; direct/custom/pool/error proxy states; cooling/disabled accounts; long email/model names; secret reveal/copy/timeout/blur; confirmation focus behavior. Done when collapsed cards are scan-friendly and every current account operation still submits the same route/body.

## Phase 5: Proxy Pool Workspace

### Files

- `app/components/ProxyPoolWorkspace.vue` (new)
- `app/App.vue`
- `app/assets/main.css`

### Changes

1. Migrate current proxy-pool types/markup to the workspace component.
2. Add top status summary for Idle, In Use, Error and Checking.
3. Place policies inside a semantic collapsible section, collapsed by default, with enabled-policy summary.
4. Keep one Save Policies action and current bounds.
5. Place bulk import inside an expandable region with exact supported syntax guidance and loading state.
6. Present import outcomes with Chinese labels for Created, Existing and Invalid while preserving masked server results.
7. Rebuild proxy list as a compact operational list/table that reflows on mobile.
8. Preserve filters, individual check, bulk check and delete behavior.
9. Explain disabled deletion for bound/checking entries through accessible descriptions.
10. Make action-specific loading visible rather than using only reduced opacity.

### Verification

Typecheck/build. Browser-check empty pool, all four statuses, bound error proxy, checking/delete conflict, partial import and long masked URLs at all target widths.

## Phase 6: Scheduler Workspace

### Files

- `app/components/SchedulerWorkspace.vue` (new)
- `app/App.vue`
- `app/assets/main.css`

### Changes

1. Migrate scheduler settings out of Accounts.
2. Keep runtime summary for pending, oldest wait and egress count.
3. Group settings into Account Capacity, Egress Capacity and Queue/Affinity.
4. Add concise accurate helper copy:
   - Queue timeout zero means no scheduler timeout.
   - Queue size zero means unbounded.
   - Direct RPM applies only while direct limiting is enabled.
   - Sticky TTL controls routing affinity lifetime.
5. Preserve current validation and single Save Scheduler action.
6. Render egress runtime as a compact table/list with status text and next availability.
7. Add saving and validation feedback on the originating section.

### Verification

Typecheck/build. Browser-check direct limiting off/on, zero queue fields, limited egress and long egress IDs at mobile/desktop widths.

## Phase 7: Request Records Workspace

### Files

- `app/components/RecordsWorkspace.vue` (new)
- `app/App.vue`
- `app/assets/main.css`

### Changes

1. Move the existing request tree and selected-detail template into `RecordsWorkspace.vue` without changing parsing or trace derivation.
2. Keep selected-record/detail caching in `App.vue` initially; pass derived records, selected trace, body presentations and callbacks.
3. Build a stable toolbar for:
   - Record enable/disable state.
   - Refresh.
   - Search.
   - All/success/failed filters.
4. Improve empty states:
   - Recording disabled and no records.
   - Recording enabled but no requests yet.
   - Filter has no results.
5. Move Clear All into an explicit danger/overflow control with existing two-step confirmation.
6. Preserve lazy detail loading, request/upstream grouping, raw JSON/SSE reveal and previous/next keyboard behavior.
7. On mobile, stack request list above selected detail and keep selected item visible.

### Verification

Typecheck/build. Browser-check disabled/enabled empty states, grouped retry/repair/continuation calls, failed trace, large record bodies, raw reveal, keyboard previous/next and mobile stacking.

## Phase 8: Gateway Settings Workspace

### Files

- `app/components/GatewaySettingsWorkspace.vue` (new)
- `app/components/ui/SecretValue.vue`
- `app/App.vue`
- `app/assets/main.css`

### Changes

1. Move client API key, minimum output budget, tool-call format, preamble verbosity and per-model overrides out of the global dashboard/accounts page.
2. Group them as External Access, Generation Budget and Tool-Call Protocol.
3. Show client API key through `SecretValue`.
4. Preserve current save functions and precedence:
   - Per-model overrides global.
   - Missing persisted values inherit environment config.
5. Use concise accurate helper copy for zero budget, dual-format parser tolerance and preamble semantics.
6. Add per-action saving state and clear inherited-vs-overridden presentation.

### Verification

Typecheck/build. Browser-check missing/configured API key, secret states, zero/non-zero budget, global/per-model overrides and long model IDs.

## Phase 9: Modal Accessibility and Final Styling

### Files

- `app/App.vue`
- `app/components/ui/AdminDialog.vue` (new only if one shared dialog wrapper removes real duplication)
- `app/assets/main.css`

### Changes

1. Audit existing add-account, proxy, model, limit, remove-account and clear-record dialogs.
2. Add focus capture, initial focus, focus trap, Escape close and focus restoration.
3. Ensure dialog titles/descriptions connect with `aria-labelledby`/`aria-describedby`.
4. Add inline submit errors where a field has a clear corrective action; keep global toast for operation failures.
5. Normalize button/action hierarchy and dangerous action presentation.
6. Apply full interaction states and `prefers-reduced-motion`.
7. Remove obsolete classes and old top-tab/dashboard layout CSS after component migration.
8. Confirm there are no nested cards or section-as-card leftovers where a divider/surface group suffices.

### Verification

Keyboard-only browser pass across every dialog and navigation surface. Typecheck/build and CSS overflow checks.

## Phase 10: Final Regression and Documentation

### Files

- `README.md`
- `breezell/NEXT_GOAL.md`
- `breezell/TODO.md`
- `breezell/breezell_report.md`

### Changes

1. Update management-panel documentation to name the six workspaces and credential masking behavior.
2. Document last-workspace persistence and mobile navigation.
3. Record that this redesign changes no server contract or gateway runtime behavior.
4. Update project state after verification; do not deploy, commit or push.

### Final Static Verification

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

### Final Browser Matrix

Run the live local page with representative mocked payloads at:

- 320px.
- 390px.
- 768px.
- Wide desktop.

Verify:

- Workspace navigation and persistence.
- Sign-out sensitive-state reset.
- Overview healthy/anomaly states.
- Account direct/custom/pool/error/cooling states and all actions.
- Password/API-key masking, copy, reveal, timeout and blur reset.
- Proxy all-status/empty/partial-import/policy states.
- Scheduler zero/limited/queue states.
- Records disabled/empty/grouped/error/raw states.
- Every modal keyboard flow.
- Focus visibility, touch targets, no overlap and no horizontal page scroll.
- No full password or authenticated proxy credential appears in rendered persistent text.

Stop after these checks pass. Production deployment remains separately authorized.
