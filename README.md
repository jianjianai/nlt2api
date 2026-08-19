# NeuralWatt OpenAI 网关

本服务将 OpenAI 兼容的 `POST /v1/chat/completions` 和
`POST /v1/responses` 转换为带 Cookie 登录态的
`https://portal.neuralwatt.com/api/chat` Playground 请求。上游真实能力、Kimi K3
视觉测试和工具调用探测结果见
[`docs/upstream-capability.md`](docs/upstream-capability.md)。

## 本地运行

复制 `.env.example` 为 `.env`，并设置三组相互独立的密钥：

- `NEURALWATT_STORE_KEY`：加密保存门户密码、会话 Cookie、Responses 状态和可选调试记录。
- `NEURALWATT_ADMIN_TOKEN`：保护管理 API 和浏览器管理面板。
- `NEURALWATT_API_KEY`：保护 OpenAI 兼容接口。未设置时默认拒绝请求；仅隔离的本地冒烟测试可以设置 `NEURALWATT_ALLOW_ANONYMOUS=true`。

启动开发服务器：

```bash
pnpm install
pnpm dev
```

管理面板位于 `http://localhost:3000/`（也可能使用 Vite 自动选择的端口）。面板会要求输入管理员令牌，令牌只保存在当前浏览器会话中。

生产风格的 Node 服务：

```bash
pnpm build
node .output/server/index.mjs
```

## OpenAI 接口

客户端使用 `Authorization: Bearer $NEURALWATT_API_KEY`（或 `x-api-key`）：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k3","messages":[{"role":"user","content":"你好"}]}'
```

`GET /v1/models` 和 `GET /v1/models/:id` 返回当前门户公开模型目录。带工具的请求会有意缓冲上游响应，校验服务端控制的 JSON 信封，然后合成为标准 OpenAI `tool_calls` 或 Responses `function_call` 项。网关不会执行客户端提供的工具；客户端应在下一轮发送 `role: "tool"` 或 `function_call_output`。客户端要求流式输出时，网关会在完成校验后重新生成标准 OpenAI SSE，因此事件格式保持兼容，但工具轮不能降低首 token 延迟。

Codex Responses 的 `namespace` 控制和内置 `web_search` 声明会作为厂商扩展接受，但不会放入门户函数契约；普通 `function` 工具仍会经过完整校验和转换，内置工具不会被网关模拟。

Responses 会话支持 `previous_response_id`，状态默认保存 12 小时；请求设置 `store: false` 时不保存。首个 Responses 请求必须提供非空字符串 `model`；已保存的续接请求可以省略模型并沿用链路模型。选中的门户账号会绑定到响应链。`instructions` 和 `tools` 是请求级字段，符合 OpenAI Responses 语义，续接时需要再次提供才会生效。门户浏览器路由不稳定支持 `developer` 角色，因此请求级 instructions 和 developer 消息会以等价的 `system` 角色发送给上游，客户端可见历史不变。

网关只在上游明确提供 `reasoning` 摘要时将其公开为 Responses 推理摘要，不会把原始 `reasoning_content` 当作公开摘要。原始推理内容保存在加密链路中；没有上游加密推理项时，`store: false` 的手工重放无法完整恢复。请求侧支持 `reasoning: { "effort": "..." }`，并映射为门户的 `reasoning_effort`；冲突的直接 `reasoning_effort` 或不支持的选项会返回错误，而不会静默忽略。

Responses 的 `text.format: {"type":"json_object"}` 会映射为门户已验证的 JSON 模式。普通文本支持；`json_schema` 会被拒绝，不会假装已经由上游强制执行。`function_call_output` 可以包含文本或 `input_image`（包括 `detail`）内容；不支持的内容类型返回 400。

## 账号池与管理面板

管理面板和以下管理接口使用 `x-admin-token`（或匹配 `NEURALWATT_ADMIN_TOKEN` 的 Bearer 令牌）保护：

- `GET /api/admin/status`、`GET /api/admin/accounts`
- `POST /api/admin/accounts`：添加邮箱/密码账号，保存前会验证登录
- `PATCH /api/admin/accounts/:id`：修改名称、权重或启用状态
- `POST /api/admin/accounts/:id/verify`：强制重新验证登录
- `DELETE /api/admin/accounts/:id`
- `GET/PATCH /api/admin/settings`：开启或关闭消息记录
- `GET /api/admin/records?limit=100`：读取脱敏的客户端/上游调试记录
- `DELETE /api/admin/records?account_id=...`：清理指定账号的调试记录
- `DELETE /api/admin/records`：清空全部调试记录（仅管理员可用）

面板的“聊天记录”页默认将请求、响应、消息角色、文本和工具调用解析成易读视图；点击“查看原始 JSON”才显示完整原始记录。消息记录默认关闭，开启后仍会脱敏并受大小上限约束。

调度使用加权 rendezvous hashing 保持会话粘性，并对无会话键的请求按有效在途负载做均衡。会话依据门户 `/dashboard` 的重定向契约刷新；聊天请求遇到过期会话时会重新登录并重试一次。账号密码和 Cookie 永远不会返回到客户端面板或写入日志。

## 限制与运维

网关会在本地校验工具名称和 JSON Schema，并限制工具数量、参数大小、工具结果、请求字节数和输出 token 数。模型没有生成可校验的控制信封时，最多执行五次有界纠错；每次纠错都从原始会话重建，保留第一次完成的思考字段，只替换最近一次无效候选，并携带精确的 JSON、策略或 Schema 错误。只有完整校验通过的候选才能转成 OpenAI 工具调用；达到上限后以 HTTP 502 失败关闭。

调试记录包含首次解析结果、纠错次数和校验错误，面板会按全部工具轮计算首次成功率。模型契约包含每个函数的完整描述和 JSON Schema，放在最新会话/工具结果之后；工具轮默认使用温度 0，内部纠错始终使用温度 0。门户请求有 `NEURALWATT_UPSTREAM_TIMEOUT_MS` 超时，以及上游响应、会话和 Responses 状态的字节上限。调试记录默认关闭；开启后保存在加密状态文件中，并受 `NEURALWATT_MAX_RECORD_BYTES` 限制。所有环境变量见 `.env.example`。

运行回归测试、类型检查和构建：

```bash
pnpm test
pnpm typecheck
pnpm build
```

端到端 Agent 门禁：

```bash
pnpm probe:cli
```

该脚本使用本机安装的 Codex 和 OpenCode，在一次性多文件 JavaScript 项目中进行真实编辑和测试。它要求通过 `NEURALWATT_PROBE_*` 环境变量提供与服务一致的本地管理员/客户端凭据，两个客户端都发送 `stream: true`，验证可见测试与隐藏测试，并在 `finally` 中删除账号、消息记录和临时工作区。只有所有项目通过、首次控制工具调用率高于 90%，且每个纠错候选最终都得到有效工具调用时才通过。OpenCode 在 Codex Windows `:workspace` 受限令牌沙箱内运行，Shell、主目录、配置和临时文件均限制在一次性项目内。独立回环请求追踪必须与调试记录分母一致，避免记录淘汰导致成功率虚高。

最近一次本地验收（2026-08-19）使用两个 CLI 和两个一次性项目。Codex 与 OpenCode 完成了全部四个项目，包括可见/隐藏测试和多文件编辑；网关观察到 35 个流式轮次、29 个受控工具意图，其中 28 个首次解析成功（96.55%），唯一一次格式错误候选在第一次纠错中成功修复（1/1，100%）。另有一次 Kimi K3 Fast 温度 2 的 20 轮流式压力测试，20 次强制工具选择不匹配全部在一次纠错内修复（100%，最终解析失败为 0）。这些是当前门户部署的验收观测值，不是对未来上游行为的永久承诺。

门户真实路由是浏览器风格的 `/api/chat`，不是另一个 `api.neuralwatt.com/v1` API。门户路由、模型目录或工具行为变更后，应重新运行探测文档中的冒烟用例。
