# Neuralwatt Portal Playground Upstream Capability Probe

**Test window:** 2026-08-18 20:58-21:22 +08:00 (12:58-13:22 UTC)
**Target:** `https://portal.neuralwatt.com/playground` and its same-origin browser APIs
**Method:** real browser-session requests, isolated anonymous HTTP checks, and deterministic low-output prompts.
**Secret handling:** credentials, session values, API keys, and cookie values were not recorded. Cookie attributes below are redacted metadata only.

## Executive Result

The Playground is backed by a browser-oriented, cookie-authenticated endpoint:

```text
POST https://portal.neuralwatt.com/api/chat
```

Its normal request body and normal SSE chunks are close to OpenAI Chat Completions, but it is **not** a native OpenAI `/v1` surface:

- `POST /api/responses`, `POST /v1/responses`, `POST /v1/chat/completions`, and `POST /api/v1/chat/completions` each returned `404 {"detail":"Not Found"}` in this test.
- The browser route accepts `tools` and later `role: "tool"` messages, but did not emit structured `message.tool_calls` or `delta.tool_calls` in any tool-generation test. It emitted model-specific text instead.
- A deterministic JSON tool-call envelope, coupled with local JSON Schema validation and synthetic standard `tool_calls`, was successful across all six tested model variants. This is the recommended adapter strategy.

The portal documentation also describes `https://api.neuralwatt.com/v1/...`, including enrolled-account `/v1/responses`. That is a separate API host and must not be conflated with the tested Portal browser surface.

## Route Matrix

| Route | Observed behavior | Authentication state tested |
| --- | --- | --- |
| `POST /api/chat` | Chat Completions-like JSON or SSE. Browser's actual upstream route. | Anonymous and signed-in |
| `GET /api/models` | `200 application/json`, `{"models":[...]}`; 12 public models at test time. | Anonymous and signed-in |
| `GET /api/usage` | `200 application/json`. Anonymous response exposed a low trial quota; signed-in Basic response was `{"rate_limited":false}`. | Anonymous and signed-in |
| `GET /auth/login` | HTML login form. | No state required |
| `POST /auth/login` | Form login; valid test account returned `303` to `/dashboard` and refreshed the session cookie. | Login flow |
| `GET /dashboard` without session | `303 See Other`, `Location: /auth/login?next=/dashboard`. | Anonymous |
| `POST /api/responses` | `404 {"detail":"Not Found"}`. | Signed-in |
| `POST /v1/responses` | `404 {"detail":"Not Found"}`. | Signed-in |
| `POST /v1/chat/completions` | `404 {"detail":"Not Found"}`. | Signed-in |
| `POST /api/v1/chat/completions` | `404 {"detail":"Not Found"}`. | Signed-in |

No WebSocket was observed in the tested Playground flows. The browser used ordinary `fetch` plus an HTTP SSE response.

## Login and Session Contract

The Portal login page contains this ordinary HTML form contract:

```text
POST /auth/login
Content-Type: application/x-www-form-urlencoded

email=<email>
password=<password>
```

- Field names are `email` and `password`; the form exposes no visible hidden CSRF field.
- A successful test login returned `303 See Other` and navigated to `/dashboard`.
- Its response set `nw_session=[redacted]; HttpOnly; Max-Age=604800; Path=/; SameSite=Lax; Secure`.
- `Max-Age=604800` is seven days. Treat it as an observed current value, not a permanence guarantee.
- The logged-out `GET /dashboard` redirect is the reliable session-health probe. Do **not** use `POST /api/chat` as the health probe: it also succeeds anonymously and would silently spend anonymous quota after an account session expires.

The browser sends the `nw_session` cookie using `credentials: "include"`. No Authorization bearer header or CSRF header was present in the Playground chat request. The browser also sent `X-Original-Referrer`, `X-UTM-Data`, and `X-PostHog-ID`; equivalent direct same-origin tests without those analytics headers succeeded, so they are not part of the minimum upstream contract.

## Model Catalog

`GET /api/models` returned `{"models":[...]}` and was usable without a session. Each object includes model identity, provider, context length, per-1K pricing, `supports_tools`, `supports_json_mode`, `supports_vision`, `supports_reasoning`, preview/flex flags, and, where relevant, a `reasoning` capability block.

| ID | Context | Tools | JSON mode | Vision | Reasoning |
| --- | ---: | :---: | :---: | :---: | :---: |
| `deepseek-v4-flash` | 1,048,576 | yes | yes | no | yes |
| `glm-5.2` | 1,048,576 | yes | no | no | yes |
| `glm-5.2-fast` | 1,048,576 | yes | no | no | yes |
| `glm-5.2-short` | 200,000 | yes | no | no | yes |
| `glm-5.2-short-fast` | 200,000 | yes | no | no | yes |
| `gemma-4-31b` | 262,144 | yes | yes | yes | yes |
| `kimi-k2.7-code` | 262,144 | yes | yes | yes | yes |
| `kimi-k2.7-code-fast` | 262,144 | yes | yes | yes | yes |
| `kimi-k3` | 1,048,576 | yes | yes | yes | yes |
| `kimi-k3-fast` | 1,048,576 | yes | yes | yes | no |
| `qwen3.6-35b` | 131,072 | yes | yes | yes | yes |
| `qwen3.6-35b-fast` | 131,072 | yes | yes | yes | no |

The published capability is useful for model selection, but the portal's actual tool-call wire behavior is described separately below and takes precedence for this adapter.

## `/api/chat` Request Contract

The Playground itself posts this shape for each turn. Conversation history lives in browser memory; there is no observed server-side conversation or previous-response ID.

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "optional system prompt" },
    { "role": "user", "content": "message" }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 2048,
  "top_p": 1
}
```

Verified accepted fields and forms:

- `model` and `messages` are required. Missing values returned `400` with `{"detail":"Model is required"}` or `{"detail":"Messages are required"}`.
- `stream: false` returned a non-streaming Chat Completions-like JSON object.
- `stream: true` returned `text/event-stream; charset=utf-8`.
- Standard `system`, `user`, `assistant`, and `tool` roles were accepted. The complete message array must be supplied again for every turn.
- Assistant `tool_calls`, tool `tool_call_id`, and optional `reasoning`/`reasoning_content` messages were accepted as incoming history.
- String content and OpenAI-style content-part arrays were accepted. A 1x1 `data:image/png` with `gemma-4-31b` produced nonzero image token accounting; DeepSeek accepted the shape but showed no image-token metric, consistent with its advertised non-vision capability.
- `response_format: {"type":"json_object"}` produced valid JSON in DeepSeek and GLM Fast tests. It also worked in the controlled tool tests below on all six tested variants.
- `tools` and `tool_choice` are accepted syntactically, including malformed tool definitions. Do not treat acceptance as upstream validation.

Observed weak validation matters for the adapter: `temperature: 9`, `max_tokens: 999999`, and a malformed tool schema all returned `200` in the Portal test. Validate OpenAI-compatible inputs, JSON Schemas, maximum generation budget, and tool names locally before forwarding them.

## Normal Response Shapes

### Non-streaming

`stream: false` returned `200 application/json` with a Chat Completions-like body. A reduced real example is:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1787058198,
  "model": "deepseek-v4-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "NW_NONSTREAM_OK",
        "function_call": null
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 14,
    "completion_tokens": 7,
    "total_tokens": 21,
    "prompt_tokens_details": { "cached_tokens": 0 }
  },
  "energy": { "energy_joules": 0.94, "energy_kwh": 2.61e-7 },
  "cost": { "request_cost_usd": 0.000004, "cache_savings_usd": 0 }
}
```

Provider additions encountered include `_latency`, `energy`, `cost`, `service_tier`, `system_fingerprint`, `stop_reason`, `token_ids`, and model-specific fields. Preserve only deliberately supported additions in any public adapter response; do not accidentally expose raw upstream diagnostics.

### Streaming

The ordinary success stream has OpenAI-like `data:` chunks plus Portal-specific SSE comments:

```text
: pricing {"prompt_per_1k":0.00014,"completion_per_1k":0.00028}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"NW"},"finish_reason":null}]}

data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}

: energy {"energy_joules":3.01,"energy_kwh":8.37e-7,"duration_seconds":2.81,...}

data: [DONE]
```

Details confirmed in multiple streams:

- The first comment is `: pricing {...}` and the terminal telemetry comment is `: energy {...}`.
- The final usage chunk has `choices: []`; usage is not guaranteed to be attached to the `finish_reason` chunk.
- The last content chunk is followed by `finish_reason: "stop"`, then usage, energy, and `[DONE]`.
- `: routing {...}` is handled by the Playground client code but was not observed in these tests.

### Error Shapes

The HTTP status alone is not sufficient for streaming calls.

| Case | Observed result |
| --- | --- |
| Missing `messages` | `400 application/json`, `{"detail":"Messages are required"}` |
| `GET /api/chat` | `405 application/json`, `{"detail":"Method Not Allowed"}` |
| Unknown model, non-streaming | `404 application/json`; wrapper body contains `error` plus textual upstream `details` |
| Unknown model, `stream: true` | **HTTP 200** with `text/event-stream`, then `data: {"error":"Gateway returned status 404","status":404}`; no normal completion sequence observed |

Always parse each SSE JSON record for `error` before treating a `200` transport status as a successful completion.

## Tool Calling: Actual Portal Behavior

### What Works

The route accepts the conventional incoming fields:

```json
{
  "tools": [{ "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object" } } }],
  "tool_choice": "auto"
}
```

It also accepts a later synthetic assistant call and tool result:

```json
[
  {
    "role": "assistant",
    "content": "",
    "tool_calls": [{
      "id": "nwcall_1",
      "type": "function",
      "function": { "name": "get_weather", "arguments": "{\"city\":\"Shanghai\"}" }
    }]
  },
  {
    "role": "tool",
    "tool_call_id": "nwcall_1",
    "content": "{\"city\":\"Shanghai\",\"temperature_c\":25,\"condition\":\"sunny\"}"
  }
]
```

All six tested variants correctly used that supplied tool result in their next response when the synthetic assistant call was included.

### What Does Not Work Reliably

Across tool-generation tests for `deepseek-v4-flash`, `glm-5.2-fast`, `gemma-4-31b`, `kimi-k2.7-code-fast`, `kimi-k3-fast`, and `qwen3.6-35b-fast`:

- The response always had `message.function_call: null`.
- No native `message.tool_calls` and no streaming `delta.tool_calls` were observed.
- The requested tool call appeared only as model text. Formats varied between calls and models, for example:

```text
tool_call(get_weather, city="Shanghai")
get_weather(location="Shanghai")
<tool_call>{"name":"get_weather","arguments":{"location":"Shanghai"}}</tool_call>
<tool_calls><invoke name="get_weather"><parameter name="city">Shanghai</parameter></invoke></tool_calls>
<function_calls><invoke name="get_weather">...</invoke></function_calls>
{"tool_calls":[{"id":"call_1","type":"function",...}]}
```

- One Kimi stream emitted an XML-like `<function_calls>` block token by token. Other runs from the same model emitted a JSON literal or even a fabricated weather object instead.
- `tool_choice: "none"`, `"auto"`, `"required"`, and a forced-function object all still produced textual tool markup in the DeepSeek comparison. Upstream `tool_choice` must therefore not be relied on for policy enforcement.

The Portal documentation's generic statement that tool calls are returned in a `tool_calls` array applies to its documented `api.neuralwatt.com/v1` API, not to the observed browser route behavior.

## Recommended Stable Tool-Call Adapter

Do not execute a tool because a model's free-form prose happens to resemble a function invocation. Textual format parsing would be model-specific, vulnerable to ambiguous prose, and impossible to make equivalent to the OpenAI contract.

Instead, for every request that exposes tools, use an internal controlled envelope:

```json
{
  "type": "tool_calls",
  "tool_calls": [
    { "name": "get_weather", "arguments": { "city": "Shanghai" } }
  ]
}
```

or:

```json
{ "type": "final", "content": "The final user-facing answer." }
```

Use a server-owned system instruction requiring exactly one of those JSON objects and no markdown/prose. Include the declared function definitions and JSON Schemas in that instruction, but omit the Portal's native `tools` and `tool_choice` fields. Send only `response_format: {"type":"json_object"}` upstream. Parse only the complete, bounded response; then validate:

1. The top-level `type` is exactly `tool_calls` or `final`.
2. Every requested tool name is in the client's declared tool set.
3. Every `arguments` object validates against that tool's JSON Schema.
4. `tool_choice: "none"`, `"required"`, or a fixed function is enforced by this adapter, not delegated to Portal.
5. Invalid JSON, an unknown tool, invalid arguments, or a violated choice policy triggers one bounded repair request or a deterministic OpenAI-compatible error. Never run a best-effort parser over arbitrary prose.

This controlled envelope was tested successfully:

- First-turn `tool_calls` JSON parsed successfully for all six variants listed above, both with and without passing `tools` to Portal.
- A two-tool request produced `get_weather` and `get_time` calls in the expected array for DeepSeek Flash, GLM Fast, and Kimi K3 Fast.
- After the adapter converted a validated envelope into a synthetic OpenAI assistant `tool_calls` message and the client returned a `role: "tool"` result, all six variants returned a valid `{"type":"final",...}` JSON answer using the supplied `25 C` result exactly.

The safest wire form is to **omit the Portal's native `tools` and `tool_choice` fields** on a tool-bearing upstream request. A later live probe showed why: `kimi-k3` generated a valid controlled envelope when the definitions were in the contract and native fields were omitted, but when native `tools` were also sent it switched to an internal `thinking` tool and never emitted the requested calculator call. `kimi-k3-fast` returned the expected envelope in the controlled adapter path. This is an observed deployment detail, not a provider guarantee, so it should be re-probed after upstream changes.

### Call Loop

For `/v1/chat/completions`, map the client's ordinary message history to Portal's `messages` array. For `/v1/responses`, normalize `input`, function-call output items, and any prior response state to the same internal message representation.

For a tool-bearing turn:

1. Preserve caller system/developer context and append the server-owned JSON-envelope contract, including the declared function names and schemas.
2. Do not forward native Portal `tools` or `tool_choice`; enforce those policies locally.
3. Internally request `stream: false` from Portal and include `response_format: {"type":"json_object"}`. Buffering is intentional: a stream cannot be safely classified as a final answer or a complete tool call until all JSON has arrived.
4. Validate the envelope. For a tool result, synthesize standard OpenAI tool-call IDs and return normal `tool_calls` (Chat Completions) or `function_call` output items (Responses) to the client.
5. The client executes its own tools and sends outputs back. Do not execute arbitrary client-defined tools inside this proxy.
6. On the next request, reconstruct the Portal history with the synthetic assistant `tool_calls` message followed by each `role: "tool"` message. Continue until a validated `final` object or a local max-round limit is reached.
7. For client-requested streaming on tool turns, synthesize standard OpenAI SSE only after the internal response has been parsed. For non-tool turns, direct SSE proxying is viable after filtering Portal comments and checking embedded error frames.

Use an explicit local maximum for tool rounds, tool count, total tool arguments bytes, and returned tool-result bytes. These are adapter policy limits; the Portal route did not demonstrate equivalent validation.

## Account Pooling Implications

Each configured Portal account needs its own server-side cookie jar. The practical health / re-login loop is:

```text
select account using sticky conversation key
  -> GET /dashboard with that account's cookie jar
  -> 200: use account
  -> 303 to /auth/login: POST /auth/login, persist refreshed cookie jar, retry health check once
  -> failure: mark account unavailable with bounded backoff
```

Do not use a successful `/api/chat` response as proof that a pooled account is signed in, because anonymous chat also worked at test time. Store cookies encrypted at rest, never expose them through the admin API or message records, and keep sticky assignment per logical OpenAI conversation/response chain so that all tool turns retain the same upstream account context.

## Debug Record Boundaries

An administrator-facing debug view can safely correlate a client request, the normalized Portal request, the selected account ID, upstream status, and the normalized response/SSE terminal state. It should make conversion failures auditable, especially the controlled tool envelope and synthetic tool-call IDs.

It must redact or omit all authentication material before persistence or display: account passwords, `nw_session` values, any `Set-Cookie` value, Authorization headers, CSRF values if the provider adds them later, and analytics identifiers. Cap stored message and tool-result bytes, record truncation, and keep the raw upstream textual tool markup only behind the explicit message-recording switch.

## Limits of This Probe

- Results are an observed Portal deployment snapshot, not a provider stability promise. Re-run smoke probes before a release that changes routing or parser behavior.
- The test did not use an `api.neuralwatt.com` API key and therefore makes no claim about the native `/v1/responses` service beyond the portal documentation's distinction.
- No rate-limit exhaustion, account ban, or browser challenge behavior was intentionally induced.
- The exact user prompt/completion records were intentionally not copied into this document beyond small deterministic protocol examples.
