# 授权服务 WebSocket 协议规格

日期：2026-08-26
状态：设计确认，待实现
关联：`2026-08-26-gateway-minter-split-design.md`

## 1. 连接

| 项 | 值 |
| --- | --- |
| 端点 | `GET {GATEWAY_URL}/ws/minter`（`http` → `ws`，`https` → `wss`） |
| 鉴权 | 请求头 `Authorization: Bearer <MINTER_TOKEN>`，在 `upgrade` 钩子内用 `timingSafeEqual` 比较 |
| 子协议 | 无 |
| 帧格式 | 仅文本帧，内容为单个 JSON 对象 |
| 单帧上限 | 64 KiB（超出即关闭连接，`code=1009`） |

鉴权失败：`upgrade` 钩子抛 `new Response("Unauthorized", { status: 401 })`，不建立连接。`MINTER_TOKEN` 未配置时一律 401，绝不放行。

握手成功后，minter 必须在 5 秒内发送 `hello`，否则 gateway 以 `code=4001` 关闭。

## 2. 消息通用结构

```ts
interface Envelope {
  type: string;
  /** 请求-响应配对用；仅需要回执的消息携带 */
  id?: string;
}
```

`id` 由发起方生成（`crypto.randomUUID()`），响应方原样回填。不认识的 `type` 一律忽略（前向兼容），不断开连接。

## 3. 生命周期消息

### 3.1 `hello`（minter → gateway）

```ts
{
  type: "hello",
  agentId: string,        // 稳定标识，重连沿用；1-64 字符
  label?: string,         // 后台展示名，≤64 字符
  version: string,        // 授权服务 package.json version
  platform: string,       // `${process.platform}-${process.arch}`
  concurrency: number,    // 同时可执行的铸票数，1-16
}
```

gateway 处理：按 `agentId` 复用或新建 `minter_sessions` 行，写 `connected_at`/`last_seen_at`/`remote_addr`，清空 `disconnected_at`。同一 `agentId` 已有活跃连接时，**关闭旧连接**（`code=4003`，`reason="replaced"`）并归还其所有 lease。

### 3.2 `welcome`（gateway → minter）

```ts
{
  type: "welcome",
  sessionId: string,        // 本次连接的会话 id，后续 lease 归属校验用
  serverVersion: string,
  heartbeatIntervalMs: number,   // minter 应按此间隔发 ping，默认 15000
  siteKey: string,               // 上游 Turnstile site key，由 gateway 下发，覆盖 minter 本地默认值
  ticketTtlSeconds: number,      // 仅供 minter 判断「铸完还剩多久值得回传」
}
```

`siteKey` 由 gateway 集中下发：上游更换 site key 时只需改 gateway 设置，不必逐台重配授权服务。minter 本地 `MINTER_SITEKEY` 仅作为 gateway 未下发时的兜底。

### 3.3 `ping` / `pong`

```ts
{ type: "ping", id: string }     // 双向均可发起
{ type: "pong", id: string }     // 原样回填 id
```

gateway 每收到任意消息即刷新 `last_seen_at`。minter 连续 60 秒未收到任何帧则主动断开重连。gateway 对 `last_seen_at` 超过 90 秒的连接执行关闭（`code=4002`，`reason="heartbeat_timeout"`）。

### 3.4 关闭码

| 码 | 方向 | 含义 |
| --- | --- | --- |
| 1000 | 双向 | 正常关闭（minter 优雅退出 / 管理员踢下线） |
| 1009 | gateway → | 帧超过 64 KiB |
| 4001 | gateway → | 未在 5s 内发送 `hello` |
| 4002 | gateway → | 心跳超时 |
| 4003 | gateway → | 同 `agentId` 被新连接替换 |
| 4004 | gateway → | 协议违规（`hello` 字段非法、消息非 JSON 对象） |

任何关闭都会：`minter_sessions.disconnected_at = now`，并释放该 `sessionId` 持有的全部 lease（把代理恢复为可领取）。

## 4. 铸票流程消息

### 4.1 `mint.request`（gateway → minter）

```ts
{
  type: "mint.request",
  id: string,            // 任务 id
  count: number,         // 期望铸造张数，1..concurrency
  deadlineMs: number,    // epoch ms；超过此刻回传的凭证 gateway 仍接受但不计入 inflight
}
```

minter 收到后为每张待铸凭证独立走「lease → 铸票 → submit」。**不需要**对 `mint.request` 本身回执；每张的结果通过 `ticket.submit` / `mint.failed` 体现。

minter 若当前无空闲并发余量，可直接忽略该请求（gateway 的 inflight 计数会在 `mintRequestTimeoutSeconds` 后自行回收）。

### 4.2 `proxy.lease`（minter → gateway）

```ts
{
  type: "proxy.lease",
  id: string,
  /** 上一次使用的代理 id；gateway 会优先续租同一条，避免重启浏览器 */
  preferProxyId?: string,
}
```

### 4.3 `proxy.leased`（gateway → minter）

```ts
{
  type: "proxy.leased",
  id: string,              // 回填 proxy.lease 的 id
  leaseId: string,
  proxyId: string,
  proxyUrl: string,        // 含凭证的完整 URL，例如 http://user:pass@1.2.3.4:8080
  kind: "http" | "socks4" | "socks5",
  expiresAt: number,       // 租约到期 epoch ms
}
```

或无可用代理时：

```ts
{
  type: "proxy.unavailable",
  id: string,
  reason: "no_active_proxy" | "all_leased" | "rate_limited",
  retryAfterMs: number,
}
```

`proxyUrl` 是明文凭证。这是协议的必要泄露面：授权服务必须能出网。因此 gateway 与授权服务之间必须使用 `wss://` 或同一私有网络，`MINTER_TOKEN` 等价于代理池读权限。

gateway 侧只下发**可用于浏览器**的代理：`kind='http'`，或不带用户名/密码的 `socks4`/`socks5`。带认证的 SOCKS 代理 Chrome 无法使用，永不下发。

### 4.4 `lease.extend` / `lease.extended`

同一代理连续铸多张时用于续租，避免中途租约到期被他人抢走：

```ts
{ type: "lease.extend", id: string, leaseId: string }
{ type: "lease.extended", id: string, leaseId: string, expiresAt: number }
{ type: "lease.lost", id: string, leaseId: string, reason: "expired" | "revoked" | "proxy_deleted" }
```

收到 `lease.lost` 后 minter 必须停止使用该代理，并重新 `proxy.lease`。

### 4.5 `lease.release`（minter → gateway）

```ts
{ type: "lease.release", leaseId: string }
```

无回执。minter 完成该代理上的全部铸票、或决定放弃时发送。优雅退出时对所有持有的 lease 逐个发送。

### 4.6 `ticket.submit`（minter → gateway）

```ts
{
  type: "ticket.submit",
  id: string,
  leaseId: string,
  token: string,          // X-DeepInfra-Turnstile 值，≤4096 字符
  source: string,         // X-Deepinfra-Source，通常 "model-embed"
  userAgent?: string,     // 铸票页面的 UA，透传给上游
  mintedAt: number,       // epoch ms，minter 侧取到 token 的时刻
}
```

### 4.7 `ticket.accepted` / `ticket.rejected`（gateway → minter）

```ts
{ type: "ticket.accepted", id: string, ticketId: string, expiresAt: number }
{
  type: "ticket.rejected",
  id: string,
  reason: "lease_invalid"   // leaseId 不存在、已过期或不属于本会话
        | "proxy_inactive"  // 代理已被删除或转为不可用
        | "already_expired" // mintedAt 过旧，入池即过期
        | "invalid_payload",
}
```

`mintedAt` 由 minter 提供但 gateway 不完全信任：`expiresAt = min(mintedAt, gatewayNow) + ticketTtlSeconds * 1000`。取 `min` 防止时钟超前的 minter 让凭证虚假延寿。若 `expiresAt - gatewayNow < ticketMinRemainingSeconds`，直接 `already_expired` 拒收。

### 4.8 `mint.failed`（minter → gateway）

```ts
{
  type: "mint.failed",
  id: string,
  leaseId?: string,        // 已领到代理时携带
  reason: MintFailureReason,
  message?: string,        // ≤512 字符，写入会话 last_error（掩码后）
}

type MintFailureReason =
  // 归因代理（gateway 给该代理计一次失败）
  | "proxy_connect_failed" | "proxy_auth_failed" | "proxy_timeout"
  // 归因本机（仅释放 lease，不影响代理健康度）
  | "browser_missing" | "browser_timeout"
  | "cdp_unreachable" | "cdp_socket" | "cdp_error" | "cdp_timeout"
  | "page_not_ready" | "no_token" | "challenge_error" | "aborted";
```

gateway 处理：`failed_count+1`；若 `reason` 属于代理归因组则按 §4.3 的失败规则更新代理状态；释放 lease（若有）；减少 inflight 计数。

## 5. 时序示例

```mermaid
sequenceDiagram
  participant G as gateway
  participant M as minter
  participant P as 代理 + Cloudflare

  M->>G: hello{agentId, concurrency:2}
  G->>M: welcome{sessionId, siteKey, ticketTtl}
  Note over G: available=1 < minAvailable=4
  G->>M: mint.request{count:2, deadline}
  M->>G: proxy.lease{}
  G->>M: proxy.leased{leaseId:L1, proxyUrl, expiresAt}
  M->>P: spawn(--proxy-server=...) → 劫持 HTML → turnstile.render
  P-->>M: token#1
  M->>G: ticket.submit{leaseId:L1, token#1}
  G->>M: ticket.accepted{ticketId, expiresAt}
  M->>G: lease.extend{leaseId:L1}
  G->>M: lease.extended{expiresAt}
  M->>P: 同页面追加容器再 render
  P-->>M: token#2
  M->>G: ticket.submit{leaseId:L1, token#2}
  G->>M: ticket.accepted{...}
  M->>G: lease.release{leaseId:L1}
```

## 6. 实现约束

- gateway 侧对每条连接维护：`sessionId`、`agentId`、`concurrency`、持有的 `leaseId` 集合、inflight 计数、`last_seen_at`。进程重启后 `minter_sessions` 中所有未标记 `disconnected_at` 的行在启动时补标，并清空全部 lease。
- 所有入站消息在处理前做结构校验：`type` 为已知字符串、数值字段为有限数且在允许区间、字符串字段长度受限。校验失败对可回执的消息回 `*.rejected{reason:"invalid_payload"}`，对无回执的消息忽略并计一次协议告警；连续 10 次协议违规关闭连接（`code=4004`）。
- 消息处理必须幂等：同一 `leaseId` 重复 `ticket.submit` 只有第一次被接受（lease 在接受时即失效），后续回 `lease_invalid`。
- minter 侧 WS 客户端用 Node 原生全局 `WebSocket`（Node 22 已稳定），无需第三方依赖。
