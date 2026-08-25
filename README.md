# DeepInfra OpenAI 网关

本服务把 OpenAI 兼容的 `POST /v1/chat/completions` 与 `POST /v1/responses` 统一调度到 DeepInfra 匿名网页线路。客户端不接触 Turnstile：网关在每次物理上游请求前通过常驻 Chrome 页面铸造一次性票据，再由选中账号的固定出口发送请求。

## 能力

- OpenAI Chat Completions 与 Responses API
- 原生 `tools`、`tool_choice`、并行工具调用、结构化 `tool_calls`
- 原生工具参数本地 JSON Schema 校验与最多五次有界修复
- SSE 流式转发、推理字段、用量汇总与 Responses 状态续接
- 多账号出口池、加权调度、粘性会话、账号/模型/出口限流和故障冷却
- HTTP、HTTPS、SOCKS4 与 SOCKS5 代理
- DeepInfra 模型目录和目录价格估算

## 本地运行

复制 `.env.example` 为 `.env`，至少设置：

```bash
DEEPINFRA_GATEWAY_ADMIN_TOKEN=replace-with-a-long-random-secret
DEEPINFRA_GATEWAY_API_KEY=replace-with-a-client-secret
DEEPINFRA_GATEWAY_DEFAULT_MODEL=moonshotai/Kimi-K3
```

DeepInfra 匿名线路依赖真实浏览器渲染。Linux 服务器需要 Chrome/Chromium、Xvfb 和可用 WebGL；项目在 GPU-less Linux 上通过 SwiftShader 提供 WebGL。Windows 会自动寻找 Edge/Chrome。

```bash
pnpm install
pnpm dev
```

管理面板位于 `http://localhost:3000/`。面板提供运行概览、账号、代理池、调度策略、请求记录和网关设置。

## OpenAI 接口

```bash
curl http://localhost:3000/v1/chat/completions \
  -H “Authorization: Bearer $DEEPINFRA_GATEWAY_API_KEY” \
  -H “Content-Type: application/json” \
  -d '{“model”:”moonshotai/Kimi-K3”,”messages”:[{“role”:”user”,”content”:”你好”}]}'
```

`GET /v1/models` 和 `GET /v1/models/:id` 返回所有启用账号共同可用的匿名 DeepInfra 模型。模型 owner 为 `deepinfra`。

工具调用直接使用 DeepInfra 的原生 OpenAI 协议。网关不会执行工具；客户端在后续轮次发送 `role: “tool”`。上游返回的结构化调用会经过名称、`tool_choice`、并行策略和参数 Schema 校验；不合格调用固定到原账号进行有界修复，校验通过前不会释放给客户端。

客户端断开会取消上游读取并释放调度容量。流式读取使用无活动超时：持续产生数据的长推理不会被固定总时长截断。

## DeepInfra 账号池

账号不是 DeepInfra 登录凭据，而是一个调度和出口身份，包含：

- 名称、启用状态与权重
- 固定出口：直连或一个显式代理
- 可调度模型列表
- 分组、账号 RPM、账号/模型并发覆盖

空代理表示服务器直连。代理故障不会改写账号出口；当前账号进入冷却并从本次请求排除，调度器自动选择其他支持该模型的账号。管理员可手动更换出口并重新验证。

调度器按启用状态、分组、模型、账号冷却、模型冷却、账号并发、账号 RPM 和出口 RPM 过滤候选。普通请求按最近一分钟加权负载公平分配；显式 `body.user`、`x-sticky-session-id`、`x-openai-session-id` 和 Responses 链提供柔性账号亲和，账号不可用时自动溢出。

每个物理上游尝试都会获取新票据；DeepInfra 票据已验证不绑定签发 IP，因此一个共享铸造器可以服务所有出口账号。

## 管理 API

管理接口使用 `x-admin-token` 或匹配 `DEEPINFRA_GATEWAY_ADMIN_TOKEN` 的 Bearer 令牌。

- `GET/POST /api/admin/accounts`
- `PATCH/DELETE /api/admin/accounts/:id`
- `POST /api/admin/accounts/:id/verify`
- `POST /api/admin/accounts/:id/models`
- `GET /api/admin/proxies`
- `POST /api/admin/proxies/import`
- `POST /api/admin/proxies/check`
- `GET/PATCH /api/admin/settings`
- `GET/DELETE /api/admin/records`
- `GET /api/admin/analytics`
- `POST /api/admin/analytics/prices/refresh`

创建账号只接受名称、权重、可选代理和分组；服务端经该账号出口验证 DeepInfra 模型目录，失败时原子回滚。

## 持久化迁移

账号状态 schema 为 v3。升级 v1/v2 状态时，只保留显式 `provider: “deepinfra”` 的账号，并保留其 ID、出口、代理池绑定、分组、模型、权重和调度覆盖。NeuralWatt 邮箱、密码、API Key、Cookie、余额和 service tier 不会转换为 DeepInfra 账号。

为避免升级时隐藏现有数据，配置代码可读取一版旧环境变量作为 fallback；部署文件和文档只使用 `DEEPINFRA_GATEWAY_*` 前缀。

## Docker

运行镜像使用 Debian、Chromium、Xvfb 和字体包：

```bash
docker compose up -d
```

Compose 挂载 `./data:/app/.data`，浏览器 profile 写入 `/app/.data/deepinfra-profile`。容器入口先启动 Xvfb，再启动 Node 网关。

## 运维

主要环境变量见 `.env.example`：

- `DEEPINFRA_GATEWAY_DATA_DIR`
- `DEEPINFRA_GATEWAY_DEFAULT_MODEL`
- `DEEPINFRA_BROWSER_PATH`
- `DEEPINFRA_DISPLAY`
- `DEEPINFRA_PROFILE_DIR`
- `DEEPINFRA_GATEWAY_UPSTREAM_TIMEOUT_MS`
- 请求、Responses 状态和上游响应大小限制

价格账本使用 DeepInfra `metadata.pricing` 的每百万 token 报价。匿名线路没有权威发票金额，因此费用标记为目录估算而不是实扣成本。

运行验证：

```bash
pnpm test
pnpm typecheck
pnpm build
```

最近一次 Responses 验收（2026-08-21）：Codex 以 `wire_api="responses"` 完成真实多文件编辑、可见测试和隐藏测试，网关观察到 7 个流式轮次、6 个受控工具意图，首次解析 6/6（100%）。`/v1/responses` 强制工具选择 20 轮（温度 0）首次成功 20/20（100%）；温度 1.5 的 20 轮中首次成功 10/20、纠错 10/10（100%），与 Chat 接口同条件结果（11/20 首次、9/9 纠错）统计等价。这些是当前门户部署的验收观测值，不是对未来上游行为的永久承诺。

最近一次本地验收（2026-08-19）使用两个 CLI 和两个一次性项目。Codex 与 OpenCode 均完成了真实多文件编辑、可见测试和隐藏测试；网关观察到 28 个流式轮次、25 个受控工具意图，25 个首次解析成功（100%），且没有失败工具调用。此前一次包含畸形 JSON 的真实轮次中，纠错 1/1 成功（100%）；另有 Kimi K3 Fast 的 20 轮强制工具选择纠错测试，20/20 在一次纠错内完成（100%）。这些是当前门户部署的验收观测值，不是对未来上游行为的永久承诺。

门户真实路由是浏览器风格的 `/api/chat`，不是另一个 `api.neuralwatt.com/v1` API。门户路由、模型目录或工具行为变更后，应重新运行探测文档中的冒烟用例。
