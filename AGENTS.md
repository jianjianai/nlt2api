本仓库是两个并列的独立项目，没有 workspace 关系：

```
gateway/   转发服务 — Nitro v3 + h3 + Vite + Vue 3 + reka-ui，SQLite（node:sqlite）
minter/    授权服务 — 纯 Node（无框架），裸 spawn Chromium + 手写 CDP
old/       拆分前的单体项目，仅作参考，不参与构建，不要修改
```

设计与实施文档在 `docs/designs/` 与 `docs/plans/`。改动前先读 `README.md` 与
[拆分架构设计](docs/designs/2026-08-26-gateway-minter-split-design.md)。

## gateway

Nitro v3 项目。`server/` 下 `api/`（/api 前缀）、`routes/`（无前缀，含 `ws/minter.ts`）、
`plugins/`、`utils/`；`app/` 是 Vue SPA；`index.html` 在项目根。写服务端代码时参考
`node_modules/nitro/dist/docs/README.md`（关于 Nitro v3 的既有知识很可能过时）。

- 路径别名 `~/*`，import 必须带显式 `.ts` 后缀。
- WebSocket 需要 `nitro.config.ts` 里的 `features.websocket: true`，否则 `defineWebSocketHandler` 不会被打包。
- `node:sqlite` 把所有列都类型化为 `SQLOutputValue`，行形状断言统一走 `server/utils/database.ts` 的 `allRows` / `getRow`，不要在调用点散落 `as`。
- 需要互斥的读改写（领取代理、取用凭证）必须用 `immediateTransaction`，靠 `BEGIN IMMEDIATE` 拿写锁实现 compare-and-set。
- 所有管理接口响应中代理 URL 走 `maskProxyUrl`、凭证走 `maskToken`；写入日志或数据库的自由文本先过 `redactProxyUrls`。

## minter

无框架，`node --experimental-transform-types` 直接跑 TS。以下约束都是实测结论，改动前先读
`src/browser.ts` 顶部注释：

- 绝不 `Runtime.enable` / `Console.enable`，会触发 Cloudflare 自动化探测 600010（裸 `Runtime.evaluate` 调用没问题）。
- 绝不用 Playwright / Puppeteer 驱动，会直接挑战失败；必须 `spawn` + 手写 CDP。
- Linux 必须保留 SwiftShader 相关 flag，无 GPU 时缺少它们出票率为零。
- 绝不禁用图片或 Translate/MediaRouter，实测出票率归零。
- 冷 profile 首次必失败，第一次铸票是丢弃结果的 warm-up。
- Chrome 无法对 SOCKS 代理做认证，带凭证的 SOCKS 代理不能铸票（gateway 侧已过滤，`src/proxy.ts` 是本地兜底）。

## 协议

`gateway/server/utils/minter-protocol.ts` 与 `minter/src/protocol.ts` 是同一份协议的两侧实现，
手工保持同步。改协议时同时更新
[协议规格](docs/designs/2026-08-26-minter-ws-protocol.md)、两侧解析器与两侧测试。

## 验证

两个项目分别在自己目录下执行 `pnpm typecheck`、`pnpm test`；gateway 另需 `pnpm build`。
test script 用目录 glob，新增测试文件无需改 package.json。

## 安全

`proxy.lease` 的响应包含明文代理凭证，`MINTER_TOKEN` 因此等价于代理池读权限——不要削弱该端点的鉴权，
也不要把代理明文写进日志或接口响应。三个密钥（`GATEWAY_API_KEY`、`GATEWAY_ADMIN_TOKEN`、`MINTER_TOKEN`）
为空时必须拒绝对应入口，不得放行。

未经用户明确要求，不要提交、推送或以任何方式修改远端状态。
