# Neuralwatt AI v2

Neuralwatt AI 是一个 Nitro 服务，将 OpenAI Chat Completions 请求转换为 NeuralWatt 门户会话请求，并提供独立的管理员控制台。v2 删除了旧版双重网页门禁、明文代理 Key、调试请求落盘和运行时自动迁移。

## 快速启动

需要 Node.js 22.12 或更高的 22.x 版本，以及 pnpm 10.34.5。

```powershell
pnpm install
$env:NEURALWATT_BOOTSTRAP_TOKEN = "replace-with-a-long-random-token"
pnpm dev
```

打开 `http://127.0.0.1:3000/`，输入 bootstrap token 并设置管理员密码。bootstrap token 仅用于首次初始化；如果未设置环境变量，服务会在启动终端中生成并显示一次临时 token。

生产构建：

```powershell
pnpm test
pnpm run typecheck
pnpm run build
pnpm run preview
```

## v1 数据迁移

运行时只接受 `version: 2`，不会静默读取或改写 v1 文件。一次性迁移工具默认生成旁路文件，不覆盖原文件：

```powershell
pnpm run data:migrate-v2
```

输出为 `.data/neuralwatt-accounts.yaml.v2.yaml`。确认后可将它作为运行文件：

```powershell
$env:NEURALWATT_DATA_FILE = ".data/neuralwatt-accounts.yaml.v2.yaml"
pnpm dev
```

迁移会保留账号凭据、Cookie、管理员密码哈希和现有推理 Key 的有效性；推理 Key 在 v2 文件中只保存 SHA-256 摘要和非敏感预览。迁移输出仍含门户账号密码和 Cookie，必须留在被 Git 忽略的 `.data/` 中。

## 管理与安全边界

- 管理 API 只接受 `nw_v2_admin` HttpOnly Cookie，不接受推理 Bearer Key。
- 管理员会话保存在内存中，有效期 12 小时；服务重启、退出或修改密码会使相应会话失效。
- 所有管理写操作要求同源请求和当前会话的 `x-csrf-token`。
- 登录和首次初始化按来源地址限速。
- 推理 Key 仅在创建时返回一次明文；持久化文件和列表 API 只含摘要或预览。
- 账号列表不返回门户密码或 Cookie，只返回 `hasPassword` / `hasCookie`。
- 状态写入采用串行 copy-on-write、schema 校验、临时文件提交和备份恢复；文件权限尽力设置为 `0600`。
- 页面和 API 默认发送 CSP、禁止嵌入、`nosniff`、同源资源策略和 `no-store` 等响应头。

账号密码和门户 Cookie 必须由服务端用于登录，因此仍以明文存在本地状态文件中。不要提交 `.data/`、`data/`、环境文件或任何凭据。

## 管理控制台

控制台包含：

- 账号新增、编辑、启停、登录、会话检查和 revision 并发保护；
- 推理 Key 创建、一次性展示、重命名、启停和撤销；
- 模型目录手动同步；
- `temperature`、`maxTokens`、`topP` 全局默认值；
- 复用同一服务链路的流式/非流式测试台；
- 管理员密码轮换和全会话撤销。

管理页面不会使用 localStorage/sessionStorage 保存密码、Cookie、CSRF token 或推理 Key。

## OpenAI 兼容接口

```text
GET  /v1/models
POST /v1/chat/completions
Authorization: Bearer <inference-key>
Content-Type: application/json
```

`stream` 省略时默认 `false`。示例：

```powershell
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Authorization: Bearer <inference-key>" `
  -H "Content-Type: application/json" `
  -d '{"model":"kimi-k3","messages":[{"role":"user","content":"只回复 TEST_OK"}],"stream":false,"max_tokens":32}'
```

已实现的请求子集：

- `model`、`messages`、`stream`、`n: 1`；
- `temperature`、`top_p`、`max_tokens`；
- `max_completion_tokens` 映射到 `max_tokens`，两者同时存在时 `max_tokens` 优先；
- system/user/assistant/tool/function 历史和匹配的工具事务；
- 文本 content parts 和 user `image_url` parts；
- `modalities: ["text"]`；
- `response_format: text | json_object`；
- function `tools`、`tool_choice` 和 `parallel_tool_calls`；
- `stream_options.include_usage`。

以下提示性字段会被接受但不会转发：`reasoning_effort`、`prompt_cache_key`、`prompt_cache_options`、`prompt_cache_retention`、`store`、`metadata`、`service_tier`、`verbosity`、`safety_identifier`、`user`。

旧 `functions` / `function_call`、developer role、音频、文件、web search、prediction、logprobs、stop、seed、`n > 1`、custom tools 和 `response_format: json_schema` 会返回明确的 400 错误。完整矩阵见 [OPENAI_CHAT_COMPATIBILITY.md](./OPENAI_CHAT_COMPATIBILITY.md)。

## JSON Agent 调用循环

NeuralWatt 门户不会原生产生标准 function tool calls。v2 使用严格的 JSON Agent 消息规则，外部客户端仍只看到标准 OpenAI `tool_calls`。

每次新任务或明确的继续指令之后，内部消息只插入一份完整 `<tool_context>`。历史工具结果保持 `tool` 角色；纠错提示和意图询问不是新任务，其后不会追加另一份工具上下文。

模型输出处理顺序：

1. 剥离可选的 `思考内容：` 和 `回复内容：` 标签。
2. 以 `{` / `[` 开头时，解析一个或多个 JSON 工具动作。
3. 按工具名、JSON Schema、命名选择和并行策略校验动作。
4. 以 `<~end~>` 开头时，移除 sentinel 并返回最终内容。
5. 普通状态文本在流式响应中展示，并作为上下文保留后询问继续或结束。

`tool_choice: required` 或命名工具不能用 `<~end~>` 绕过调用。失败候选会被最新候选替换，只保留首轮 reasoning；最多 4 次纠错、6 个模型轮次。调用方给出的 `max_tokens` 是整个内部循环的累计 completion token 预算，不会按轮次重复使用。

工具由客户端执行。客户端回传完整 `assistant.tool_calls` 和逐一匹配的 `role: tool` 结果后，再发起下一次请求；若要得到最终正文，应使用 `tool_choice: auto` 或省略该字段。

## 流式与重试

- 普通文本 `stream: true` 直接转换上游 SSE，不先缓冲完整响应。
- 客户端取消会传递到账号池和门户请求。
- SSE 注释被忽略；JSON 数据帧、`finish_reason`、usage 和 `[DONE]` 被标准化。
- Agent 工具动作在完整 JSON 和 Schema 校验成功后原子输出；中间状态可逐轮流式展示。
- 只有在上游尚未开始输出且明确为认证失败时，才刷新会话或切换账号。
- 429 可以切换下一个账号；超时、未知执行状态或已开始的流不会自动重放。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `NEURALWATT_DATA_FILE` | v2 YAML 状态文件，默认 `.data/neuralwatt-accounts.yaml` |
| `NEURALWATT_BOOTSTRAP_TOKEN` | 首次管理员初始化 token；生产环境建议显式设置 |
| `NEURALWATT_PORTAL_ORIGIN` | 门户源站，默认 `https://portal.neuralwatt.com`；非回环地址必须 HTTPS |
| `NEURALWATT_MODEL_CATALOG_URL` | 模型目录地址，默认 NeuralWatt 公共 `/v1/models` |
| `NEURALWATT_TRUST_PROXY=1` | 信任 `x-forwarded-*` 以识别外部协议、主机和来源地址 |
| `NEURALWATT_SECURE_COOKIES=1` | 强制管理员 Cookie 使用 `Secure` |
| `NITRO_HOST` / `NITRO_PORT` | 监听地址和端口 |

Compose 额外读取 `NEURALWATT_HOST_PORT` 作为宿主端口，默认 `3000`。

公网部署必须使用 HTTPS，并在反向代理或防火墙层限制管理控制台的可达范围。

## Docker

```powershell
$env:NEURALWATT_BOOTSTRAP_TOKEN = "replace-with-a-long-random-token"
docker compose up -d
docker compose ps
```

默认镜像为 `ghcr.io/jianjianai/nlt2api:2.0.0`，只绑定宿主 `127.0.0.1`，状态保存在 `neuralwatt-data` 命名卷中。Compose 会显式传入 bootstrap、门户、代理信任和 Secure Cookie 配置；若未设置 bootstrap token，仍会生成并打印一次临时 token。容器内应用以非 root 用户运行，`/health` 会验证 v2 状态可读且状态目录可写。

## 验证

```powershell
pnpm test
pnpm run typecheck
pnpm run build
```

测试覆盖 OpenAI 请求合同、工具历史与调用循环、JSON Schema 方言、累计 token 预算、状态事务、账号故障转移、SSE 预检/透传、摘要式 Key、管理员会话/CSRF 和错误归一化。
