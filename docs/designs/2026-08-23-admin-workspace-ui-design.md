# Admin Workspace UI Redesign

## Status

Approved conversational design awaiting review of this written specification.

## Objective

Reorganize the existing Vue 3 management panel into an operations-focused workspace that is easier to scan, safer around credentials, clearer about real gateway behavior, and stable on desktop and mobile.

This is a frontend information-architecture and interaction redesign. It must preserve the current API contracts and runtime semantics for accounts, sessions, proxies, scheduling, tool-call policy, output budgets and debug records.

## Verified Current Product Surface

The existing admin panel and server currently provide:

- Authenticated admin status containing accounts, scheduler runtime, proxy-pool runtime, settings and gateway configuration.
- Account creation, verification, enable/disable, deletion, proxy editing, proxy-pool assignment, model refresh/manual editing and scheduler-limit overrides.
- Proxy-pool import, status filtering, individual/bulk health checks, deletion and policy configuration.
- Global scheduler settings for account/model concurrency, account RPM, proxy/direct egress RPM, queue limits and sticky TTL.
- Global minimum output budget, tool-call envelope format, preamble verbosity and per-model overrides.
- Debug-record enable/disable, search, status filtering, grouped client/upstream calls, detail loading and deletion.
- Toast notifications, confirmation dialogs and responsive layouts.

No server route, data model or runtime behavior is added by this redesign.

## Design Direction

Use a technical, data-dense operations workspace rather than a marketing-style dashboard or decorative card wall.

The visual hierarchy is driven by:

- Stable navigation.
- Compact operational summaries.
- Thin dividers and restrained surfaces.
- One functional accent for selected/action states.
- Semantic colors plus text labels for health states.
- High data-to-decoration ratio.

Avoid oversized headings, nested cards, decorative gradients, broad explanatory prose, floating page sections and repeated credential blocks.

## Navigation and Information Architecture

### Desktop

Use a persistent left workspace rail with:

1. Overview.
2. Accounts.
3. Proxy Pool.
4. Scheduler.
5. Request Records.
6. Gateway Settings, separated at the bottom.

The top bar contains the product identity, connection state, refresh action and sign-out action. The main content area renders only the selected workspace.

### Mobile

At widths below the desktop workspace breakpoint, replace the left rail with a fixed bottom navigation containing:

- Overview.
- Accounts.
- Proxies.
- Scheduler.
- Records.

Gateway Settings opens from a clearly labelled settings control in the mobile top bar. Reserve bottom safe-area padding and content padding so the navigation never covers controls or data.

### Persistence

The first successful login opens Overview. Later sessions restore the last selected workspace from local storage.

Signing out clears:

- Admin token.
- Temporary form state.
- Open dialogs and expanded account details.
- Revealed-secret state.
- Selected debug-record detail.

Signing out preserves the last-workspace preference.

## Overview Workspace

Overview is an anomaly-first operational home, not a second settings page.

### Primary metrics

Show compact values derived from existing status payloads:

- Enabled accounts / total accounts.
- Healthy proxies / total proxies.
- Current account requests in flight and scheduler pending count.
- Error proxies and cooling accounts.

Use tabular numerals. Metrics are not separate decorative cards on narrow screens; they become a compact two-column summary.

### Action required

Build a derived, bounded action list from existing state:

- Error proxy.
- Cooling account.
- Model-specific cooldown.
- Non-zero queue depth or old waiting request.
- Client API key not configured.

Each item includes the affected object, concise state, relevant time and a direct navigation/action affordance such as Check Proxy, View Account or Open Scheduler.

Do not invent alarms or thresholds not represented by the current payload.

### Operational summaries

Below action-required items, show compact account load and egress RPM summaries using the current account runtime and scheduler egress snapshot. Link to the owning workspace for management.

## Accounts Workspace

Use compact operational cards. Each card's collapsed state shows only the fields required to compare account health:

- Label and email.
- Runtime status.
- Egress type and pool state.
- Account RPM usage.
- Model requests in flight.
- Next availability when limited.
- Session state.
- Configured model count.
- Primary Manage action.

Cards must remain compact enough to scan several accounts without exposing full credentials or every action.

### Expanded management

Manage expands the selected card in place. Only one account is expanded at a time.

The expanded region groups controls by ownership:

- Credentials: email and masked password.
- Egress: direct/custom/pool proxy, pool state and proxy actions.
- Models: model refresh and manual model list.
- Limits: account RPM, account/model concurrency and per-model overrides.

Verification, enable/disable and deletion are secondary actions. Deletion uses the existing confirmation dialog.

A direct account offers Assign from Pool. An account with a proxy offers Manage Proxy. Display existing session semantics accurately: changing egress preserves the stored session and authentication refresh occurs only if the portal rejects it.

## Sensitive Values

Use a reusable SecretValue component for:

- Account passwords.
- Client API key.

Behavior:

- Mask by default.
- Copy works without permanently revealing the value.
- Show reveals one value for 30 seconds.
- Switching workspace, signing out, opening another secret or window blur re-masks it immediately.
- Use text plus accessible labels for Show, Hide and Copy states.
- Never place secrets in titles, tooltips, toast text or persistent local storage.

Proxy-pool list addresses remain masked because the current admin APIs intentionally expose masked URLs only.

## Proxy Pool Workspace

Preserve all current features while creating four visual layers.

### Status summary

Show Idle, In Use, Error and Checking counts from the existing proxy-pool snapshot.

### Policies

Place pool policies in a collapsible section, collapsed by default. The collapsed summary names the currently enabled policy behaviors.

Controls remain:

- Auto-assign on account creation.
- Auto-rotate on transport failure.
- Retry current request after rotation.
- Direct fallback when exhausted.
- Default import protocol.
- Health-check timeout.
- Error retry cooldown.

Use one explicit Save Policies action and preserve current validation bounds.

### Import

Use an expandable import region with:

- Visible one-proxy-per-line label.
- Full URL, host:port, host:port:user:pass, user:pass@host:port and bracketed-IPv6 guidance.
- Default protocol context.
- One Import Proxies action with loading state.
- Per-line created/existing/invalid results.

Do not echo raw authenticated proxy lines beyond the existing masked server result.

### List

Show:

- Masked address.
- Protocol.
- Status.
- Bound account.
- Last health check.
- Retry time.
- Last error.

Support existing filters, individual check, bulk error/all check and deletion. Error proxies still bound to an account remain undeletable.

## Scheduler Workspace

Structure scheduler settings according to the real admission pipeline.

### Runtime summary

Show:

- Pending requests.
- Oldest wait.
- Egress group count.

### Account capacity

- Account/model concurrency.
- Account RPM.

### Egress capacity

- Proxy RPM.
- Direct egress limiting switch.
- Direct egress RPM.

### Queue and affinity

- Queue timeout seconds.
- Maximum queue size.
- Sticky TTL seconds.

Each field has one concise helper sentence that accurately explains `0`, inheritance or enablement behavior. Do not expose implementation-detail prose in the interface.

Show scheduler egress runtime as a compact table with egress ID, account count, requests/RPM, limiting state and next availability.

Save through the existing settings endpoint with inline/loading feedback.

## Request Records Workspace

Retain the existing client-request tree and selected-detail workbench because it maps to real debug-record ownership.

Improve only the surrounding interaction:

- Place record enablement status, refresh, search and status filters in a stable toolbar.
- When recording is disabled and no records exist, explain that enabling recording captures future requests only.
- Keep full record details lazy-loaded.
- Preserve grouping for initial, retry, repair and continuation upstream calls.
- Move Clear All into an overflow/danger menu and retain two-step confirmation.
- Keep original JSON/SSE behind an explicit reveal action.

## Gateway Settings Workspace

Move the current global non-scheduler settings here:

- Client API key display/copy through SecretValue.
- Minimum upstream output budget.
- Global tool-call envelope format.
- Global preamble verbosity.
- Per-model envelope-format overrides.
- Per-model preamble-verbosity overrides.

Group by External Access, Generation Budget and Tool-Call Protocol. Use the exact current behavior in helper copy:

- A minimum output budget of zero respects client values.
- Per-model settings override global settings.
- Tool parsing accepts both JSON and XML even when one format is requested.
- Preamble verbosity controls user-visible progress narration, not model capability or tool execution behavior.

## Component Boundaries

Use Vue 3 single-file components without adding another UI framework or icon package.

Create workspace-level components:

- `WorkspaceShell.vue`.
- `OverviewWorkspace.vue`.
- `AccountsWorkspace.vue`.
- `ProxyPoolWorkspace.vue`.
- `SchedulerWorkspace.vue`.
- `RecordsWorkspace.vue`.
- `GatewaySettingsWorkspace.vue`.
- `SecretValue.vue`.

`App.vue` remains the authenticated data/action owner during this refactor. It passes typed state and action callbacks to workspace components. This avoids moving server synchronization into several competing owners.

Do not split every field or button into a component. Native semantic HTML and shared CSS classes remain appropriate for simple controls.

## Visual Tokens

Continue using CSS custom properties, but normalize values around one system:

- Background: cool near-white.
- Surface: white and one subtle secondary surface.
- Primary ink: deep navy.
- Functional accent: restrained teal.
- Semantic warning/error/success colors.
- Four-pixel spacing base.
- Six-pixel control radius.
- Eight-pixel panel radius.
- Thin dividers; shadows only where elevation conveys interaction.

Typography:

- Chinese/UI body: `"Microsoft YaHei UI", "PingFang SC", sans-serif`.
- Data/IDs: `Consolas, "SFMono-Regular", monospace`.

No remote font dependency is introduced.

## Interaction and Accessibility

- Use semantic buttons, inputs, labels, navigation and lists/tables.
- All controls support default, hover, active, focus-visible, disabled and loading states.
- Touch targets are at least 44px on mobile.
- Status always includes text and never relies on color alone.
- Dialogs focus the first useful control, trap focus, close with Escape and restore focus to the opener.
- Inputs have visible labels; validation appears on submit or blur with a fix.
- Respect `prefers-reduced-motion`.
- Preserve keyboard navigation for record previous/next behavior without stealing arrows from form controls.
- Desktop and mobile navigation expose the current location through semantics and visible state.

## Content Style

Use concise, operational Chinese copy.

- Explain what a setting changes and the important default/zero behavior.
- Avoid describing visual structure, keyboard shortcuts or implementation internals inside the product.
- Prefer precise actions: Add Account, Check Proxy, Save Policies, Assign from Pool.
- Async success and failure toast text names the affected object and outcome.
- Disabled dangerous operations include a reason in adjacent helper text or an accessible description.

## Responsive Behavior

Validate at 320px, 390px, 768px and wide desktop.

- Desktop left rail becomes mobile bottom navigation.
- Main content reserves bottom-safe-area space.
- Account cards become single column.
- Scheduler field groups become single column.
- Proxy rows stack address, metadata and actions.
- Record workbench becomes request list followed by selected detail.
- No horizontal page scrolling.
- Long IDs, model names, URLs and errors wrap safely without resizing controls.

## Error, Empty and Loading States

Required states:

- Initial dashboard loading.
- Empty account list with Add Account action.
- Empty proxy pool with Import Proxies action.
- Proxy check/import partial failure.
- Disabled request recording with enable guidance.
- No debug records yet.
- No filter/search results with clear-filter action.
- Account/proxy action loading on the originating control.
- Failed status refresh while preserving the last successful snapshot and showing a recoverable toast.

## Verification

### Static and contract checks

- Typecheck all Vue props/emits and workspace state.
- Production build.
- Existing backend tests remain unchanged and passing.
- Add focused tests only for newly extracted pure UI-state helpers when practical; do not create a new frontend test harness solely for this redesign.

### Browser verification

Use the live local page with representative mocked admin-status payloads covering:

- Healthy overview.
- Cooling account and model cooldown.
- Idle, checking, in-use and error proxies.
- Bound error proxy deletion disabled.
- Non-zero queue and limited egress.
- Empty states.
- Partial proxy import failure.
- Request-record list/detail.
- Credential masking, timed reveal, copy and blur reset.
- Workspace persistence and sign-out reset behavior.

Check 320px, 390px, 768px and desktop for overflow, overlap, focus order and touch targets.

## Out of Scope

- Server API or persistence changes.
- New account/proxy/scheduler behavior.
- New analytics thresholds or alerting services.
- Dark mode.
- External UI framework or icon-library introduction.
- Remote fonts.
- Production deployment, commit or push.
