# Output Budget and Account Egress Design

## Status

- Date: 2026-08-22
- State: Approved in chat; pending written-spec review
- Project: nlt2api

## Background

Production records showed that client requests with `max_output_tokens: 128` frequently spent most of that budget on reasoning and returned zero to two visible characters.
The same records showed that all three NeuralWatt accounts share XIGONG2's IPv4 egress and therefore share the portal's limit of 30 requests per minute per IP.
XIGONG and XIGONG2 each have three configured global IPv6 addresses, but both currently have failed or incomplete IPv6 gateway neighbors and cannot make IPv6 connections.

## Goals

1. Prevent small client budgets from starving visible model output.
2. Make the minimum upstream output budget configurable at runtime.
3. Split NeuralWatt accounts across independently verified egress paths.
4. Preserve the existing account, proxy, session, tool-call, and streaming ownership boundaries.

## Non-goals

- Do not change the client-visible requested token budget in Responses objects.
- Do not promise unique egress IPs from free shared WARP.
- Do not move the nlt2api application away from XIGONG2.
- Do not expose SOCKS listeners, account credentials, or management endpoints to the public Internet.

## Output Budget Policy

### Effective budget

Add one global setting named `minimumOutputTokens`.
- Default effective value: `8192`.
- Valid values: integers from `0` through `8192`.
- `0` disables the floor and respects the client's explicit budget.
- A positive value raises smaller client budgets but never lowers larger requested budgets.

The portal still receives at most its supported single-round limit of 8192 tokens.

```text
clientBudget = max_completion_tokens ?? max_tokens
configuredDefault = existing default output budget
floor = minimumOutputTokens
requested = clientBudget ?? configuredDefault
upstreamRoundBudget = min(8192, max(requested, floor))
```

The floor applies to every model and to both Chat Completions and Responses requests.

### Configuration ownership

Add `minimumOutputTokens?: number` to the persisted `ProxySettings` owner.
Add `NEURALWATT_MIN_OUTPUT_TOKENS`, defaulting to `8192`, as the environment-level fallback.
A persisted value wins over the environment default; a missing persisted value inherits the environment default.
A stored value of `0` is explicit and must not be treated as missing.

### API

`GET /api/admin/status` returns the environment default under `config.minimumOutputTokens`.
`GET /api/admin/settings` returns the persisted override when one exists.
`PATCH /api/admin/settings` accepts `minimumOutputTokens` with these rules:
- Integers from `0` through `8192` are accepted.
- Non-integers, negative values, and values above `8192` return HTTP 400.
- Updates apply to new requests immediately without restarting the service.

### Admin UI

Add a numeric control labeled 「最小上游输出预算」 to the existing global settings area.
The control uses `min=0`, `max=8192`, and `step=1` and displays the effective value.
- `0` displays 「已关闭，尊重客户端预算」.
- A positive value explains the concrete behavior, for example 「客户端请求 128 时，上游使用 8192」.
Saving uses an explicit 「保存」 command and the existing toast notification pattern.

### Compatibility

Responses continue to echo the client's original `max_output_tokens` in the response object.
Chat Completions retain the current public request contract.
Debug records continue to store the original client request and the actual portal request, making the raised budget observable.
Existing continuation behavior remains available when a client requests more than 8192 tokens.

## Egress Architecture

### Current facts

- XIGONG2 IPv4 egress is `117.55.235.10`.
- XIGONG IPv4 egress is `117.55.234.187`.
- Both hosts run Ubuntu 22.04 and have three configured global IPv6 addresses.
- Both hosts currently fail IPv6 gateway neighbor discovery and cannot use IPv6 externally.
- WireGuard already connects XIGONG `10.88.0.1` to XIGONG2 `10.88.0.2`.
- All three NeuralWatt accounts currently use XIGONG2's direct IPv4 egress.

### Phase 1: two independent IPv4 exits

Run one SOCKS5 service on XIGONG for use by XIGONG2.
- Listen only on XIGONG's WireGuard address `10.88.0.1:11080`.
- Allow connections only from XIGONG2 `10.88.0.2`.
- Egress through XIGONG's direct IPv4 address.

Bind accounts through the existing per-account `proxy` field.
- One account remains direct on XIGONG2.
- One account uses `socks5h://10.88.0.1:11080` through XIGONG.
- The third account is assigned only after observing load and rate-limit behavior on the two exits.

The exact account-to-exit assignment is operational state, not a new application schema.

### Phase 2: repair native IPv6

Work with the hosting provider or correct host networking so both IPv6 gateways resolve to reachable neighbors.
Acceptance requires:
1. The default gateway neighbor becomes `REACHABLE`, `STALE`, or another usable state.
2. `curl -6` can reach Cloudflare from each host.
3. `portal.neuralwatt.com` completes DNS, TCP, and TLS over IPv6.
4. Binding each configured source IPv6 produces the expected distinct public source address.

Once working, run local SOCKS endpoints that bind outbound sockets to one fixed source IPv6 each.
Each account can then use its existing proxy field to select a stable source IPv6 without changing application routing logic.

### Phase 3: isolated WARP exits

If native IPv6 cannot be repaired promptly, test WARP as an additional source of exits.
1. Create one network namespace per candidate WARP tunnel.
2. Run one WireGuard/WARP interface inside each namespace.
3. Run one SOCKS5 listener per namespace on a host-local or WireGuard-reachable address.
4. Keep the host default route, SSH, Nginx, and existing `wg0` outside the namespaces.
5. Bind an account only after Cloudflare trace and NeuralWatt connectivity tests prove the exit is usable and unique.

Free shared WARP does not guarantee a unique or stable egress IP, so duplicate exits are rejected.
For deterministic unique exits, use Cloudflare Zero Trust Dedicated Egress or independent commercial proxies.

### Fail-closed proxy behavior

A proxied account must not silently fall back to a host's direct route.
Proxy failure leaves that account unavailable and lets the existing scheduler cool it down.
Health checks must distinguish proxy failure, portal rate limiting, and authentication failure.

## Data Flow

1. A client request enters Chat Completions or Responses validation.
2. The shared budget resolver reads the client budget and the effective persisted/environment floor.
3. The scheduler selects an account using existing affinity and load rules.
4. `portalClient` uses the account's configured proxy dispatcher or the host's direct route.
5. Portal failures update only the selected account's existing runtime state.
6. Output conversion preserves the original client-visible request metadata.

## Security

- SOCKS listeners bind only to loopback or WireGuard addresses.
- Firewall rules allow only the expected peer source address and port.
- WARP and SOCKS credentials stay in root-readable service configuration.
- Existing account credentials and cookies remain in the encrypted/persisted application state boundary.
- Management responses must continue returning masked proxy details rather than proxy credentials.

## Observability

Use existing debug records to compare the client budget with the actual portal `max_tokens` value.
Operational verification records:
- Effective minimum output budget.
- Account label and a non-secret egress route identifier.
- Portal 429 and no-account 503 counts by minute.
- Distinct external IP fingerprints for each configured proxy path.

Do not record raw proxy credentials, account passwords, cookies, or full public IPs in application logs.

## Verification

### Budget policy

1. Unit-test budget resolution for missing, zero, below-floor, equal, above-floor, and above-portal-cap values.
2. Test persisted settings reload, including explicit zero and invalid stored values.
3. Test the admin PATCH boundary for `0`, `8192`, negative, fractional, and oversized values.
4. Verify a Responses request with `max_output_tokens: 128` sends portal `max_tokens: 8192` while its response metadata remains 128.
5. Verify Chat Completions uses the same floor.
6. Verify the admin panel loads, edits, saves, and displays the effective value.

### Phase 1 egress

1. Request Cloudflare trace directly from XIGONG2 and record its egress fingerprint.
2. Request the same trace through XIGONG's WireGuard-only SOCKS endpoint.
3. Prove the two fingerprints differ.
4. Verify login, session probe, model list, and chat through each path.
5. Apply controlled load and confirm one exit's rate limit does not cool accounts on the other exit.

### IPv6 and WARP

1. Test every candidate route from its own namespace or bound source address.
2. Verify Cloudflare trace returns a reachable external address.
3. Verify NeuralWatt DNS, TCP, TLS, login, and chat.
4. Reject duplicate or unstable egress paths.
5. Stop one proxy and confirm its account fails closed without falling back to direct egress.

## Deployment and Rollback

1. Build with the project's required Node 22.23.2 runtime, not Node 24.
2. Deploy the budget feature as a new atomic release and retain the current release.
3. Set the persisted floor to `8192` and verify a real 128-token request.
4. Deploy XIGONG's WireGuard-only SOCKS service independently from the application release.
5. Verify the XIGONG route before assigning one account.
6. Observe rate-limit distribution before assigning the third account.
7. Treat native IPv6 and WARP as later validation-gated stages.

Budget rollback sets `minimumOutputTokens` to `0` without restarting.
Egress rollback clears the affected account proxy and verifies a new direct session.
Application rollback atomically switches the release symlink and restarts `nlt2api`.

## Risks

- A higher budget can increase latency and token consumption for intentionally small requests.
- Shared WARP may collapse multiple tunnels onto one exit and provide no rate-limit benefit.
- Broken IPv6 neighbor discovery is outside the application's ownership boundary.
- Multiple accounts on one IP still share the portal's per-IP limit.
- A remote SOCKS dependency adds a WireGuard and service availability dependency.

## Acceptance Criteria

- A client request for 128 output tokens sends 8192 to the portal by default.
- Setting the floor to 0 restores exact client-budget behavior.
- Both public APIs share the same policy and preserve their response contracts.
- The admin panel validates, persists, and displays values from 0 through 8192.
- At least two accounts can use two proven distinct IPv4 exits across XIGONG2 and XIGONG.
- Each proxied account fails closed when its route is unavailable.
- WARP routes are assigned only when unique egress is observed.
- SSH, Nginx, the public API, and the existing WireGuard link remain available throughout rollout.

## Implementation Boundaries

- Budget calculation belongs in the shared upstream request builder.
- Setting validation and persistence belong in the existing config, state store, and admin settings API.
- UI work stays in the existing global settings surface.
- XIGONG SOCKS and firewall configuration stay outside the application release.
- IPv6 repair stays with host/provider networking.
- Production changes proceed in separate atomic stages with independent rollback.

## Decisions Resolved

- The floor applies globally to all models.
- The default floor is 8192.
- Zero disables the floor.
- XIGONG is part of the egress pool.
- Native IPv6 is preferred over WARP when repaired.
- WARP is validation-gated and not assumed to provide unique exits.
- The nlt2api application remains on XIGONG2.