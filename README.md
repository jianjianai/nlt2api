# nlt2api

一个把上游匿名 Web 推理接口封装成 OpenAI 兼容 API 的网关，拆为两个独立部署的服务。

```
gateway/   转发服务：代理池、凭证对池、任务编排、OpenAI 兼容转发、管理后台
minter/    授权服务：连 gateway 的 WS，领代理，用 HTML 劫持铸 Turnstile 凭证并回传
old/       拆分前的单体项目（仅作参考，不参与构建）
```

## 为什么拆

上游的匿名接口要求每次请求携带一张一次性 Cloudflare Turnstile 凭证，而铸造凭证需要一个真实渲染管线的 Chromium（含 Xvfb，每实例约 1.6 GB）。单体形态下转发逻辑被迫和浏览器同镜像、同进程，无法独立扩容，铸票耗时还直接压在客户端请求延迟上。

拆开后：转发服务是一个约 100 MB 的纯 Node 进程；铸票能力可以横向加机器；凭证改为预铸池化，客户端不再等待铸票。

## 数据流

```
客户端 ──/v1/chat/completions──▶ gateway ──取 (代理, 凭证) 对──▶ 上游
                                   │            └─ 池空则 FIFO 排队，有票即唤醒
                                   ├─ 水位不足 ──WS mint.request──▶ minter
                                   └─ minter ──proxy.lease──▶ 领一个空闲活跃代理
                                              ──ticket.submit──▶ 回传凭证入池
```

水位不是固定值：目标常备量按**实测消耗速率 × 备货时长**动态伸缩（夹在可配的上下限之间），
长时间无请求则暂停铸票，下一个请求到达时自动恢复。高峰期凭证跟不上时请求排队而不是直接 503；
排队上限与超时可配，客户端断开即刻出队。

关键约束（均有实测依据，见 `docs/designs/`）：

- 凭证一次性，被上游赎回后重放返回 403，因此每次物理重试都必须换一张。
- 未使用的凭证自然寿命约 3~4 分钟（178 秒仍可用，245 秒必失效），所以池的默认 TTL 是 170 秒，取用时优先消耗最接近过期的一张。
- 凭证与铸造它的代理成对存储与使用，凭证与出口 IP 永不错配。
- 上游的匿名限流按出口 IP 计算：新对话取最久未用的出口以分散压力，同一对话在黏滞窗口内固定出口以保持身份一致；铸票同样按出口轮转，票均匀分布在所有 IP 上。
- 遭 429 的出口短暂冷却，遭非 captcha 的 403/401（上游拒绝该 IP 本身）冷却明显更久；冷却期内该 IP 同时停止转发与铸票。对话身份优先取客户端传的 `X-Session-Id`（或请求体 `session_id`），没有则回退到对话头部的哈希；黏滞出口暂时没票时会立即为它铸票并让请求等待，超过等待窗口才接受其他出口。

## 文档

- [拆分架构设计](docs/designs/2026-08-26-gateway-minter-split-design.md)
- [授权服务 WS 协议规格](docs/designs/2026-08-26-minter-ws-protocol.md)
- [实施计划](docs/plans/2026-08-26-gateway-minter-split-implementation.md)

## 快速开始

```bash
# 转发服务
cd gateway && pnpm install
cp .env.example .env   # 填写 GATEWAY_ADMIN_TOKEN / GATEWAY_API_KEY / MINTER_TOKEN
pnpm dev               # http://localhost:3000，管理后台在同一地址

# 授权服务（另一个终端，可在另一台机器）
cd minter && pnpm install
cp .env.example .env   # 填写 GATEWAY_URL 与同一个 MINTER_TOKEN
pnpm start
```

进入管理后台后：导入代理 → 等待测活转为「活跃」（延迟 ≤ 500ms 且速度 ≥ 1Mbps 才算达标，否则为「不符合条件」并记录原因）→ 凭证池自动补充 → 用 `GATEWAY_API_KEY` 调用 `/v1/chat/completions`。

## Docker

```bash
GATEWAY_ADMIN_TOKEN=... GATEWAY_API_KEY=... MINTER_TOKEN=... docker compose up -d
```

`minter` 可通过 `MINTER_REPLICAS` 增加副本。注意每个铸票并发约需 1.6 GB 内存。

## 安全边界

- 三个密钥彼此独立，均不可为空：`GATEWAY_API_KEY`（客户端）、`GATEWAY_ADMIN_TOKEN`（后台）、`MINTER_TOKEN`（授权服务）。为空时对应入口一律拒绝而非放行。
- **`proxy.lease` 下发给授权服务的代理 URL 含明文凭证**（否则无法出网），因此 `MINTER_TOKEN` 等价于代理池读权限。生产环境务必让两者位于同一私有网络，或使用 `wss://`。
- 管理接口的所有响应中代理 URL 与凭证均已掩码，明文只存在于服务端数据库与内存。
- `GATEWAY_ALLOW_ANONYMOUS=true` 会让 `/v1` 完全开放，仅限内网自用。

## 验证

两个项目各自执行：

```bash
pnpm typecheck
pnpm test
pnpm build      # 仅 gateway
```
