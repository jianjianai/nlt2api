# 转发服务 / 授权服务 拆分实施计划

日期：2026-08-26
设计依据：`docs/designs/2026-08-26-gateway-minter-split-design.md`、`docs/designs/2026-08-26-minter-ws-protocol.md`

## Phase 1：仓库骨架

1. 根目录建 `gateway/` 与 `minter/` 两个并列独立项目（各自 `package.json`、`tsconfig.json`、`.env.example`、`Dockerfile`）；根 `compose.yaml` 编排两者；根 `README.md` 说明拆分关系。
2. `gateway/`：Nitro v3 + Vite + Vue 3 + `reka-ui`，依赖 `undici`、`socks`；`nitro.config.ts` 打开 `features.websocket`，`routeRules` 给 `/v1/**` 开 CORS 与 `no-store`。
3. `minter/`：无框架纯 Node，`package.json` 仅 devDeps（`typescript`、`@types/node`），入口 `src/main.ts`，`node --experimental-transform-types` 直接跑 TS。
4. 两个项目共用测试方案：`node:test` + `--experimental-transform-types` + `~/*` 路径别名 loader（从 `old/tests/alias-loader.mjs` 迁移）。test script 用目录 glob 而非逐个列举文件，避免新增测试被漏跑。

## Phase 2：gateway 存储与领域层

1. `server/utils/config.ts`：环境变量解析（三个密钥、`dataDir`、各类上限），带 `resetForTests()`。
2. `server/utils/database.ts`：`node:sqlite` `DatabaseSync` 单例，`WAL`/`busy_timeout`/`foreign_keys` 设置，`schema_migrations` 递增迁移框架，`transaction()` 与 `immediateTransaction()` 助手。
3. 迁移 v1：建 `proxies`、`tickets`、`minter_sessions`、`settings` 四表与索引。
4. `server/utils/proxy.ts`：从 `old/` 迁移 URL 解析、规范化、导入行解析、掩码、undici dispatcher（含 SOCKS 连接器与 LRU 缓存）。新增 `browserProxyTarget(url)` 拆出 `--proxy-server` 值与认证凭证，并判定该代理是否可用于浏览器（带认证的 SOCKS 不可用）。
5. `server/utils/settings.ts`：`settings` 表读写，带默认值合并与逐字段校验。
6. `server/utils/proxy-pool.ts`：三态状态机、导入、快照（掩码 + 派生字段）、`markChecked`/`markFailed`、`leaseProxy`（`BEGIN IMMEDIATE` + 优先续租 + 凭证数最少优先）、`extendLease`、`releaseLease`、`releaseSessionLeases`、启动时清理过期租约。
7. `server/utils/ticket-pool.ts`：`insertTicket`（校验 lease、计算 `expiresAt`）、`claimTicket`（最接近过期优先 + 最小剩余过滤 + 代理必须 active）、`dropTicket`、`cleanupExpired`、`availableCount`、`snapshot`。
8. 单元测试：代理解析与导入、三态转移、lease 排他性（并发 lease 只有一个成功）、凭证取用顺序与过滤、过期清理、`expiresAt` 的 `min(mintedAt, now)` 钳制。

## Phase 3：gateway 上游与转发层

1. 迁移 `server/utils/http.ts`（`HttpError`、`jsonResponse`、`openAIErrorResponse`、`readJsonObjectWithRaw`、`requireAdminAuth`、`requireClientAuth`），去掉组 API key 分支。
2. 迁移 `server/utils/upstream-http.ts`、`upstream-stream.ts`、`upstream-retry.ts`。
3. `server/utils/upstream.ts`：`chatCompletions(request, ticket, proxy, signal)` 与 `modelCatalog(proxy, signal)`；错误分类（`transport` / `captcha` / `rate_limit` / `model_capacity` / `upstream`）。
4. `server/utils/forward-service.ts`：取凭证 → 发上游 → 按错误类型决定重试/损耗归因；流式一旦开始转发即不再重试。
5. 路由：`routes/health.get.ts`、`routes/v1/models.get.ts`、`routes/v1/models/[id].get.ts`、`routes/v1/chat/completions.post.ts`、`routes/v1/[...path].options.ts`。
6. 测试：凭证耗尽返回 503 + `Retry-After`；403 captcha 换凭证重试；传输失败给代理计失败；流式首帧后不重试。

## Phase 4：gateway 编排与 WS Hub

1. `server/utils/minter-hub.ts`：连接注册表（`sessionId` → 连接元数据、lease 集合、inflight 计数）、消息校验与分派、心跳超时扫描、同 `agentId` 替换、关闭时释放 lease。
2. `server/routes/ws/minter.ts`：`defineWebSocketHandler`，`upgrade` 钩子做 `MINTER_TOKEN` 常量时间校验。
3. `server/utils/refill-orchestrator.ts`：缺口计算（`min(minAvailable - available - inflight, idleActiveProxies)`）、按会话轮转下发、inflight 超时回收。
4. `server/utils/proxy-checker.ts`：后台批量探测 `pending` 且冷却已过的代理。
5. `server/utils/ticket-cleaner.ts`：过期凭证清理。
6. `server/plugins/runtime.ts`：启动三个定时器与启动期一致性修复（补标离线会话、清空 lease），Nitro `close` 钩子里全部停止。
7. 测试：协议编解码与非法载荷拒绝、缺口计算、inflight 回收、幂等 submit（同 lease 二次提交被拒）、心跳超时关闭。

## Phase 5：gateway 管理 API 与后台 UI

1. Admin API：`overview`、`proxies`（列表/导入/批量测/单测/改/删）、`tickets`（列表/清空）、`minters`（列表/踢下线）、`settings`（读/写）。全部首行 `requireAdminAuth`，响应全部掩码。
2. 前端：`App.vue`（token 登录 + `api()` 封装 + 状态），`WorkspaceShell.vue`（侧边导航、主题、自动刷新），五个工作区（概览、代理池、凭证对池、授权服务、设置）。CSS 与 `components/ui/*` 从 `old/` 迁移。
3. 测试：admin 鉴权（缺 token 401、未配置 503）、掩码不泄露明文、设置校验拒绝越界值。

## Phase 6：minter 服务

1. `src/config.ts`：环境变量解析与校验（缺 `GATEWAY_URL`/`MINTER_TOKEN` 直接退出）。
2. `src/cdp.ts`：手写最小 CDP 客户端（原生 `WebSocket`），仅 `Page`/`Fetch` 域，绝不 enable `Runtime`/`Console`。
3. `src/browser.ts`：`spawn` 启动（精简 flags + 平台 flags + `--proxy-server` + `--proxy-bypass-list`）、可执行文件探测、profile 目录管理、空闲回收、代理变更时重启。
4. `src/minter.ts`：HTML 劫持（`Fetch.fulfillRequest` 注入 trap 页面）、`Fetch.authRequired` → `continueWithAuth`、`turnstile.render` 轮询取 token、同页面追加容器复用、warm-up 丢弃首次、串行化。
5. `src/client.ts`：WS 客户端（`hello`/`welcome`/心跳/退避重连）、任务队列、lease 管理、`ticket.submit`/`mint.failed` 上报、优雅退出归还 lease。
6. `src/main.ts`：装配与信号处理。
7. 测试：配置校验、trap HTML 生成、CDP 消息编解码、失败原因归因映射、重连退避序列、`browserProxyTarget` 与认证分支。

## Phase 7：部署与验证

1. `gateway/Dockerfile`：`node:22-bookworm-slim` 两阶段，无浏览器依赖。
2. `minter/Dockerfile`：`node:22-bookworm-slim` + `chromium xvfb fonts-liberation fonts-noto-*`，entrypoint 先起 `Xvfb :99` 再跑 Node。
3. 根 `compose.yaml`：gateway 挂载 `./data`，minter 注入 `GATEWAY_URL`/`MINTER_TOKEN`，支持多副本。
4. 两个项目分别 `pnpm typecheck`、`pnpm test`、`pnpm build` 全绿。
5. 生产等同验证（人工）：真实代理下连续铸 20 张统计接受率；多副本授权服务并发；长时间运行水位稳定性；客户端 `/v1/chat/completions` 流式与非流式端到端。
