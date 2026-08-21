# nlt2 OpenAI 网关

本服务将 OpenAI 兼容的 `POST /v1/chat/completions` 和 `POST /v1/responses`
转换为带 Cookie 登录态的
`https://portal.neuralwatt.com/api/chat` Playground 请求。上游真实能力、Kimi K3
视觉测试和工具调用探测结果见
[`docs/upstream-capability.md`](docs/upstream-capability.md)。

## 本地运行

复制 `.env.example` 为 `.env`，并设置两组相互独立的密钥：

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

`GET /v1/models` 和 `GET /v1/models/:id` 返回当前门户公开模型目录。无工具轮在上游每个 SSE 分片到达时立即转换并转发：Chat 会分别发送 `reasoning`、`reasoning_content` 和 `content` delta。流式链路带读取背压；客户端断开会立即取消上游请求并释放账号，损坏的上游 SSE 会失败关闭。上游退回 JSON 时会自动降级为一次性 SSE，不会使客户端等待或中断。带工具的请求会有意缓冲上游响应，校验服务端控制的 JSON 信封，然后合成为标准 OpenAI `tool_calls`（可选携带用户可见的 `content`/preamble）；这是为了避免执行半截或无效的 JSON。网关不会执行客户端提供的工具；客户端应在下一轮发送 `role: "tool"`。工具轮的 SSE 在校验完成后生成，因此不能降低该轮首 token 延迟。

客户端请求的 `developer` 消息会以等价的 `system` 角色发送给上游，客户端可见历史不变。

Chat 会保持上游的 `reasoning` 与 `reasoning_content` 两个字段并在流中分别转发。请求侧支持 `reasoning: { "effort": "..." }`，并映射为门户的 `reasoning_effort`；冲突的直接 `reasoning_effort` 或不支持的选项会返回错误，而不会静默忽略。

## Responses 接口

`POST /v1/responses` 与 Chat 接口共用同一套执行、工具适配和纠错管线，行为一致：

- `input` 支持字符串和条目数组：`message`（`input_text`/`output_text`/`input_image`/`refusal`）、`function_call`、`function_call_output`、`custom_tool_call`、`custom_tool_call_output` 和 `reasoning` 条目。连续的函数调用会合并为一个 assistant 轮次；`reasoning` 条目的 `encrypted_content`（或摘要文本）会还原为上游 reasoning 字段。`item_reference` 返回 400。
- `instructions` 作为请求级系统指令；`tools` 接受扁平的 `function` 定义和 `custom` 自由文本工具（以 `{ "input": "..." }` 包装参与契约，输出时还原为 `custom_tool_call`）。`web_search`、`namespace` 等托管工具会被丢弃，不会进入门户函数契约，也不会被网关模拟。
- `tool_choice` 支持 `auto`/`none`/`required` 和指定函数；`max_output_tokens` 映射为 `max_completion_tokens`；`reasoning.effort` 映射为 `reasoning_effort`；`text.format` 的 `json_object`/`json_schema` 映射为 `response_format`；`prompt_cache_key` 用作粘性会话键。
- 流式发送完整的 `response.created` → `response.output_item.added` → 推理摘要/正文/函数参数 delta → `response.output_item.done` → `response.completed` 事件序列；工具轮在校验完成后一次性释放函数调用项，与 Chat 工具轮的缓冲语义一致。失败时以 `response.failed` 事件收尾。
- `store` 默认开启：每个响应的完整条目链保存在服务端，`previous_response_id` 可续接（沿用链路模型），状态保留 12 小时并受 `NEURALWATT_MAX_RESPONSE_HISTORY_BYTES`/`NEURALWATT_MAX_RESPONSE_STATE_BYTES` 限制。`store: false` 的客户端（如 Codex）自行重放完整历史，不依赖服务端状态。
- 推理文本以 `reasoning` 输出项的摘要形式实时展示，同时编码进 `encrypted_content` 供客户端回传还原；这与 Chat 接口直接转发 reasoning 字段等价。

## 账号池与管理面板

管理面板和以下管理接口使用 `x-admin-token`（或匹配 `NEURALWATT_ADMIN_TOKEN` 的 Bearer 令牌）保护：

- `GET /api/admin/status`、`GET /api/admin/accounts`
- `POST /api/admin/accounts`：添加邮箱/密码账号，保存前会验证登录；可选 `proxy` 字段为该账号指定出口代理
- `PATCH /api/admin/accounts/:id`：修改名称、权重、启用状态或代理（`proxy` 传 URL 字符串设置，传 `null` 或空字符串清除）
- `POST /api/admin/accounts/:id/verify`：强制重新验证登录
- `DELETE /api/admin/accounts/:id`
- `GET/PATCH /api/admin/settings`：开启或关闭消息记录
- `GET /api/admin/records?limit=100`：读取调试记录摘要列表（不含请求/响应正文，含预览与上游调用元数据）
- `GET /api/admin/records/{id}`：按需读取单条完整调试记录（包含全部脱敏正文与上游调用）
- `DELETE /api/admin/records?account_id=...`：清理指定账号的调试记录
- `DELETE /api/admin/records`：清空全部调试记录（仅管理员可用）

面板的“聊天记录”页按一个客户端请求分组：左侧先列出客户端请求，再列出首次请求、纠错轮、续写轮、上游重试和会话刷新重发等全部上游调用。右侧从每项原始请求正文和响应正文解析对话、消息、工具调用及全部字段；点击“查看原始数据”可读取完整 JSON 或 SSE 文本。消息记录默认关闭。开启后只会脱敏认证和会话等敏感字段，不会截断已接收的消息正文。

每个账号可以单独设置一个出口代理，支持 `http://`、`https://`、`socks4://`、`socks5://`（含 `socks4a`/`socks5h`）协议，认证信息可直接写在 URL 中（如 `socks5://user:pass@host:1080`）。设置后该账号的登录、会话探测和聊天请求全部经由代理发出；修改或清除代理会使该账号的会话失效并通过新代理重新登录。面板中只显示脱敏后的代理地址，代理认证信息不会返回到浏览器。

调度使用加权 rendezvous hashing 保持会话粘性，并对无会话键的请求按有效在途负载做均衡。会话依据门户 `/dashboard` 的重定向契约刷新；聊天请求遇到过期会话时会重新登录并重试一次，遇到网络失败、超时或 408/425/5xx 等暂时性门户错误时，每个账号请求最多尝试三次。账号密码和 Cookie 永远不会返回到客户端面板或写入日志。

## 限制与运维

网关会在本地校验工具名称和 JSON Schema，并限制工具数量、参数大小、工具结果、请求字节数和输出 token 数。模型没有生成可校验的控制信封时，最多执行五次有界纠错；每次纠错都从原始会话重建，保留第一次完成的思考字段，只替换最近一次无效候选，并携带精确的 JSON、策略或 Schema 错误。只有完整校验通过的候选才能转成 OpenAI 工具调用；达到上限后以 HTTP 502 失败关闭。

调试记录包含首次解析结果、纠错次数和校验错误，面板会按全部工具轮计算首次成功率。模型契约包含每个函数的完整描述和 JSON Schema，放在最新会话/工具结果之后；工具轮默认使用温度 0，内部纠错始终使用温度 0。客户端可发送任意正整数的 `max_tokens`/`max_completion_tokens` 预算，服务端不再设置上限。门户当前实际接受的单次 `max_tokens` 上限是 8,192。客户端预算超过该值且上游以 `finish_reason: "length"` 截断时，网关会在同一账号上自动续接，并合并后续内容，直到达到客户端预算、模型正常结束或达到内部续接轮数上限。未指定预算时仍使用 8,192 的默认单轮生成预算。门户请求使用 `NEURALWATT_UPSTREAM_TIMEOUT_MS` 作为响应头和相邻响应数据之间的无活动超时；持续产生数据的长推理 SSE 不受固定总时长限制。另有上游响应和会话的字节上限。`reasoning.effort` 会接受并校验，常见 SDK 发送的 `null` 默认值也会忽略；门户没有摘要开关，因此只转发有效的 `reasoning.effort`。调试记录默认关闭；开启后每个客户端请求单独写入一个 JSON 文件，保留全部已接收的原始正文。所有环境变量见 `.env.example`。

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

该脚本使用本机安装的 Codex 和 OpenCode，在一次性多文件 JavaScript 项目中进行真实编辑和测试。设置 `NEURALWATT_CLI_PROBE_CLIENTS=codex-responses` 可让 Codex 改用 Responses 线协议（`wire_api="responses"`）运行同一任务；`NEURALWATT_PROBE_ENDPOINT=responses` 可让 `probe:tools` 通过 `/v1/responses` 测量首次工具调用成功率和纠错成功率。它要求通过 `NEURALWATT_PROBE_*` 环境变量提供与服务一致的本地管理员/客户端凭据，两个客户端都发送 `stream: true`，验证可见测试与隐藏测试，并在 `finally` 中清理脚本自己创建的账号、消息记录和临时工作区。对已有账号做验收时设置 `NEURALWATT_PROBE_ACCOUNT_ID`；脚本只清理本次临时工作区，不删除该账号或其历史记录。只有所有项目通过、首次控制工具调用率高于 90%，且每个纠错候选最终都得到有效工具调用时才通过。OpenCode 在 Codex Windows `:workspace` 受限令牌沙箱内运行，Shell、主目录、配置和临时文件均限制在一次性项目内。独立回环请求追踪必须与调试记录分母一致，避免记录淘汰导致成功率虚高。

最近一次 Responses 验收（2026-08-21）：Codex 以 `wire_api="responses"` 完成真实多文件编辑、可见测试和隐藏测试，网关观察到 7 个流式轮次、6 个受控工具意图，首次解析 6/6（100%）。`/v1/responses` 强制工具选择 20 轮（温度 0）首次成功 20/20（100%）；温度 1.5 的 20 轮中首次成功 10/20、纠错 10/10（100%），与 Chat 接口同条件结果（11/20 首次、9/9 纠错）统计等价。这些是当前门户部署的验收观测值，不是对未来上游行为的永久承诺。

最近一次本地验收（2026-08-19）使用两个 CLI 和两个一次性项目。Codex 与 OpenCode 均完成了真实多文件编辑、可见测试和隐藏测试；网关观察到 28 个流式轮次、25 个受控工具意图，25 个首次解析成功（100%），且没有失败工具调用。此前一次包含畸形 JSON 的真实轮次中，纠错 1/1 成功（100%）；另有 Kimi K3 Fast 的 20 轮强制工具选择纠错测试，20/20 在一次纠错内完成（100%）。这些是当前门户部署的验收观测值，不是对未来上游行为的永久承诺。

门户真实路由是浏览器风格的 `/api/chat`，不是另一个 `api.neuralwatt.com/v1` API。门户路由、模型目录或工具行为变更后，应重新运行探测文档中的冒烟用例。
