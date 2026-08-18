# Nlt 2 api

这是一个本地/局域网 Nitro 服务，将 OpenAI `v1/chat/completions` 请求转换为 Nlt 门户的 `/api/chat` 请求，并提供账号和会话管理面板。

## 启动

```powershell
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:3000/` 后，先使用网页访问密钥解锁管理页面。管理页面会显示、生成和管理本地代理 Bearer Key；首次没有配置 `NEURALWATT_PROXY_KEY` 时，服务会在终端输出新生成的 Key，供脚本调用和初始化管理员密码使用。

账号和模型管理 API 同时接受网页访问会话、管理员密码会话或启用的代理 Bearer Key，现有脚本无需修改。`/v1/*` 始终只接受启用的 Bearer Key。

也可以使用环境变量固定管理员密码（优先级高于保存的密码，忘记密码时可用于恢复）：

```powershell
$env:NEURALWATT_ADMIN_PASSWORD = "your-strong-password"
pnpm dev
```

构建和预览：

```powershell
pnpm run build
pnpm run preview
```

需要局域网访问时，在 PowerShell 中显式绑定地址：

```powershell
$env:NITRO_HOST = "0.0.0.0"
pnpm dev
```

OpenAI 兼容接口始终需要代理 Bearer Key。管理网页可使用独立网页访问密钥保护，但公开部署时仍应通过 HTTPS、网络边界和访问控制限制服务暴露范围。

## 网页访问密钥

公网部署时，管理页面 `/` 需要独立的网页访问密钥。启动前在被忽略的 `.env.local` 中设置 `NEURALWATT_WEB_ACCESS_KEY`；解锁后服务器会写入一个仅限网页使用的 HttpOnly Cookie，有效期为 12 小时，服务重启后需要再次解锁。

该门禁保护管理页面及其静态资源。管理 API 在已建立网页会话时可直接调用，也继续兼容已启用的代理 Bearer Key；`/v1/*` 始终只接受已启用的代理 Bearer Key，`/health` 不需要认证。

## 代理 Key 管理

代理 Key 以明文保存在被忽略的 `.data/neuralwatt-accounts.yaml` 中，并只会在已解锁的管理页面返回。可以创建多个 Key、重命名、启用/停用或删除；停用和删除会立即撤销对应的 `/v1/*` 访问权限。旧版 YAML 中的 `proxy.apiKey` 会在首次加载时自动迁移为「Default key」。

## 调试追踪

设置 `NEURALWATT_DEBUG_TRACE=1` 后启动服务，`/v1/chat/completions` 的每次已认证请求都会在 `.data/debug/<trace-id>/` 创建独立目录。目录按实际顺序保存客户端原始请求、每轮重建后的上游请求及其原始响应，以及最终发给客户端的 JSON 或 SSE 响应。

```powershell
$env:NEURALWATT_DEBUG_TRACE = "1"
pnpm dev
```

默认每个流式响应最多记录 8 MiB；通过 `NEURALWATT_DEBUG_MAX_BYTES` 调整上限，或通过 `NEURALWATT_DEBUG_DIR` 指定其他根目录。认证请求头不会写入文件，Cookie、密码、API Key 和 Bearer 值会脱敏。调试完成后关闭环境变量并按需删除 `.data/debug/`。

## 账号和会话

账号数据保存在 `.data/neuralwatt-accounts.yaml`，其中密码和会话 Cookie 按项目需求以明文保存。该文件已加入 `.gitignore`，仍应限制操作系统文件权限。

直接登录使用门户当前公开的表单接口：

```text
POST https://portal.neuralwatt.com/auth/login
Content-Type: application/x-www-form-urlencoded

email=...&password=...
```

登录成功后缓存 `Set-Cookie`，并使用 `/api/usage` 检查会话。遇到 Cloudflare 挑战、验证码或其他异常时，在面板中粘贴手动 Cookie。密码、Cookie 和代理 Key 不会通过账号列表接口返回。

## OpenAI 兼容接口

接口地址：

```text
GET  http://127.0.0.1:3000/v1/models
POST http://127.0.0.1:3000/v1/chat/completions
Authorization: Bearer <local-proxy-key>
Content-Type: application/json
```

`GET /v1/models` 只返回本地 YAML 中已保存的模型目录，不会联网。管理面板的「获取并保存模型」按钮会手动读取官网目录、过滤不可调用的 `-flex` 模型及 DeepSeek Canary 别名，然后覆盖保存；响应保留模型原始元数据与目录 `scope`。当前本地登录态不含官网 API Key，因此手动获取的范围通常是公开目录。Chat Completions 在调用方省略 `stream` 时默认使用 SSE；传入 `stream: false` 可请求完整 JSON 响应。

示例：

```powershell
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Authorization: Bearer <local-proxy-key>" `
  -H "Content-Type: application/json" `
  -d '{"model":"kimi-k3","messages":[{"role":"user","content":"请只回复 TEST_OK"}],"stream":false,"max_tokens":32}'
```

已实现并映射：

- 文本消息、system/user/assistant 以及历史 tool/function 消息；
- `stream` 流式和非流式响应；
- `temperature`、`top_p`、`max_tokens`；
- `max_completion_tokens` 到 `max_tokens` 的转换；两者同时存在时按门户实测优先使用 `max_tokens`；
- 文本图片输入；
- `response_format: text` 和 `json_object`；
- 标准 JSON/SSE 响应和 OpenAI 风格错误。
- 上游 `reasoning` / `reasoning_content` 会作为兼容扩展统一输出为 `reasoning_content`；连续对话中客户端传入的 assistant `reasoning_content` 会映射回门户 `reasoning`；正文仍在标准 `content` 字段中。
- 现代 function tools：`tools`、`tool_choice` 和 `parallel_tool_calls`，响应还原为标准 `message.tool_calls` / `delta.tool_calls`；参数 Schema 支持未声明版本、draft-06/07、draft-2019-09 和 draft-2020-12。

已确认不具备标准语义、静默丢弃会造成误导的字段会返回 400，包括旧版 `functions` / `function_call`、custom tools、developer role、音频、文件、web search、prediction、logprobs、stop、seed、`n > 1` 和 OpenAI Structured Outputs 的 `json_schema` 模式。纯提示性字段（`reasoning_effort`、`prompt_cache_key`、`prompt_cache_options`、`prompt_cache_retention`、`store`、`metadata`、`service_tier`、`verbosity`、`safety_identifier`、`user`）会被接受并忽略，门户对这些字段没有对应语义，拒绝它们会无谓地阻断 opencode 等真实客户端。

### 工具调用实现

门户不会原生解析工具定义。适配器使用显式 JSON Agent loop：每次模型生成前，都会从原始消息、已确认的工具调用/结果和当前纠错状态重新构建请求；包含当前工具目录、JSON 调用格式和完成约束的 `<tool_context>` 始终位于最后一条 user 消息。

模型输出以 `{` 或 `[` 开头时，必须是完整 JSON 工具调用：单个调用使用 `{ "name": "tool_name", "arguments": { ... } }`，数组仅在 `parallel_tool_calls` 允许时可用。代理用 Ajv 按调用方提供的完整 Schema 校验工具名和参数，然后以标准 OpenAI `tool_calls` 返回；工具仍由调用方执行。

模型以 `<~end~>` 开头时结束生成，sentinel 后的内容作为最终报告。普通状态文本不会被当作最终回复，而会进入下一轮并要求模型继续输出合法工具调用或最终 sentinel。

JSON 解析失败、结构错误、未知工具、Schema 错误和并行策略冲突都会进入统一纠错流程。纠错上下文只保留最新失败候选，不会累积多个错误输出；第一次模型 reasoning 会保留，错误详情始终对应最新候选。纠错次数和 Agent 总轮次均有上限，超过上限会返回结构化错误。

支持的选择方式：

- `tool_choice: "auto" | "none" | "required"`；
- 指定函数的 `{ "type": "function", "name": "..." }`；
- `parallel_tool_calls: false` 会严格限制为一次最多一个调用。

合法工具调用被确认后会以标准 `message.tool_calls` 或 `delta.tool_calls` 返回给客户端。客户端执行工具并发送对应的 `role: "tool"` 结果后，下一次请求会重新进入 Agent loop。内部 `<tool_context>`、纠错提示和 `<~end~>` sentinel 不会泄漏给 OpenAI 客户端。

账号按轮询使用。只有在上游尚未开始推理且明确是会话认证失败时，代理才会刷新登录或切换下一个账号；流式数据开始、超时或未知请求状态不会自动重发。

## 验证

```powershell
pnpm test
pnpm run build
```

`tests/` 覆盖请求字段校验、token 映射、工具协议、参数 Schema、JSON 归一化和 SSE 归一化。真实账号登录应通过面板手动触发，凭据不会放入测试文件。
