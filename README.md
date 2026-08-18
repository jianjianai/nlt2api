# NeuralWatt OpenAI Gateway

This service exposes OpenAI-compatible `POST /v1/chat/completions` and
`POST /v1/responses` endpoints backed by the cookie-authenticated
`https://portal.neuralwatt.com/api/chat` Playground route. The upstream behavior
probe, including the tested Kimi K3 vision path and tool-call findings, is in
[`docs/upstream-capability.md`](docs/upstream-capability.md).

## Local Setup

Copy `.env.example` to `.env` and set three independent secrets:

- `NEURALWATT_STORE_KEY` encrypts portal passwords, session cookies, Responses
  state, and optional debug records at rest.
- `NEURALWATT_ADMIN_TOKEN` protects the management API and the browser panel.
- `NEURALWATT_API_KEY` protects OpenAI-compatible clients. The gateway rejects
  requests when it is missing unless `NEURALWATT_ALLOW_ANONYMOUS=true` is set
  for an isolated local smoke test.

Run the development server:

```bash
pnpm install
pnpm dev
```

The management panel is served at `http://localhost:3000/` (or the port Vite
selects). It asks for the admin token and stores it only in the browser session.

For a production-style Node server:

```bash
pnpm build
node .output/server/index.mjs
```

## OpenAI Endpoints

Use `Authorization: Bearer $NEURALWATT_API_KEY` (or `x-api-key`) from clients.
The adapter supports text and OpenAI content parts, including `image_url` and
data URLs for vision-capable portal models such as `kimi-k3`.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k3","messages":[{"role":"user","content":"Hello"}]}'
```

`GET /v1/models` and `GET /v1/models/:id` mirror the current public Portal
model catalog. Tool-bearing turns intentionally buffer the upstream response,
validate a server-owned JSON envelope, and then synthesize standard OpenAI
`tool_calls` or Responses `function_call` items. The gateway never executes
client-supplied tools; the client sends the resulting `role: "tool"` or
`function_call_output` message on the next turn. Client-requested streaming is
reconstructed after that validation. The current adapter buffers Portal
responses before emitting normalized OpenAI SSE chunks, so streaming preserves
the event contract but does not reduce time-to-first-token.

Responses conversations can use `previous_response_id`; state is retained for
12 hours unless the request sets `store: false`. A first Responses request must
send a non-empty `model`; a stored continuation may omit it and reuses the chain
model. The selected account remains bound to a stored response chain.
`instructions` and `tools` are request-scoped, matching OpenAI Responses
semantics, so resend them on continuation requests when they are needed. The
Portal browser route does not reliably accept a `developer` role, so
request-level Responses instructions are sent upstream as the equivalent leading
`system` message. The adapter exposes an upstream `reasoning` value as a public
Responses reasoning summary, but does not reinterpret raw Portal
`reasoning_content` as a public summary. Raw reasoning content remains in the
encrypted stored chain; it cannot be reconstructed by a `store: false` manual
replay without an upstream-provided encrypted reasoning item. The supported
request-side reasoning control is `reasoning: { "effort": "..." }`, which maps
to the Portal's `reasoning_effort`; conflicting direct `reasoning_effort` values
and unsupported reasoning options are rejected instead of silently ignored.

## Account Pool

The panel and these admin routes are protected by `x-admin-token` (or a Bearer
token matching `NEURALWATT_ADMIN_TOKEN`):

- `GET /api/admin/status` and `GET /api/admin/accounts`
- `POST /api/admin/accounts` to add an email/password account. Login is checked
  before the account is accepted.
- `PATCH /api/admin/accounts/:id` to change label, weight, or enabled state.
- `POST /api/admin/accounts/:id/verify` to force a fresh login check.
- `DELETE /api/admin/accounts/:id`
- `GET/PATCH /api/admin/settings` for message recording.
- `GET /api/admin/records?limit=100` for redacted client/upstream debug records.

Scheduling uses weighted rendezvous hashing for sticky conversation keys, then
least effective in-flight load for unkeyed traffic. Sessions are refreshed from
the Portal's `/dashboard` redirect contract and retried once when a chat request
gets an expired-session response. Account passwords and cookies are never sent
to the client panel or written to logs.

## Limits and Operations

The adapter validates tool names and JSON Schemas locally, limits tool count,
arguments, tool results, request bytes, and output tokens, and applies a bounded
repair request when a model fails the controlled envelope. Portal requests have
an abort timeout (`NEURALWATT_UPSTREAM_TIMEOUT_MS`) plus bounded upstream,
conversation, and aggregate Responses-state sizes. Debug recording is off by
default; when enabled it is redacted and stored inside the encrypted state file
with a configurable byte budget (`NEURALWATT_MAX_RECORD_BYTES`). See
`.env.example` for every limit.

Run the regression suite, static check, and build before deployment:

```bash
pnpm test
pnpm typecheck
pnpm build
```

The upstream is a browser-oriented `/api/chat` service, not the separate
`api.neuralwatt.com/v1` API. Re-run the probe document's smoke cases after a
Portal routing or model-catalog change.
