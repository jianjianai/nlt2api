# Nlt 2 api

这是一个本地/局域网 Nitro 服务，将 OpenAI `v1/chat/completions` 请求转换为 Nlt 门户的 `/api/chat` 请求，并提供账号和会话管理面板。

## 启动

```powershell
pnpm install
pnpm dev
```

首次启动时会在终端输出本地代理 Bearer Key（供脚本调用和初始化管理员密码使用）。打开 `http://127.0.0.1:3000/`：首次访问输入该 Key 设置管理员密码，之后凭密码登录管理台。管理台中可以轮换或自定义代理 Key、维护门户账号、测试兼容接口、修改管理员密码。

也可以用环境变量固定管理员密码（优先级高于管理台保存的密码，忘记密码时可用它恢复）：

```powershell
$env:NEURALWATT_ADMIN_PASSWORD = "your-strong-password"
pnpm dev
```

管理 API（`/api/...`）同时接受管理员会话 Cookie 和代理 Bearer Key，现有脚本无需修改。

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

局域网访问必须使用代理 Bearer Key。不要把服务直接暴露到公网。

## 调试追踪

设置 `NEURALWATT_DEBUG_TRACE=1` 后启动服务，`/v1/chat/completions` 的每次已认证请求都会在 `.data/debug/<trace-id>/` 创建独立目录。目录中按实际顺序保存单独的 JSON 文件：客户端原始请求、每次上游请求及其原始响应（包括内部续推和工具纠错重试），以及最终发给客户端的 JSON 或 SSE 响应。

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
POST http://127.0.0.1:3000/v1/chat/completions
Authorization: Bearer <local-proxy-key>
Content-Type: application/json
```

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
- `max_completion_tokens` 到 `max_tokens` 的转换；
- 文本图片输入；
- `response_format: text` 和 `json_object`；
- 标准 JSON/SSE 响应和 OpenAI 风格错误。
- 上游 `reasoning` / `reasoning_content` 会作为兼容扩展统一输出为 `reasoning_content`；连续对话中客户端传入的 assistant `reasoning_content` 会映射回门户 `reasoning`；正文仍在标准 `content` 字段中。
- 现代 function tools：`tools`、`tool_choice` 和 `parallel_tool_calls`，响应还原为标准 `message.tool_calls` / `delta.tool_calls`；参数 Schema 支持未声明版本、draft-06/07、draft-2019-09 和 draft-2020-12。

已确认不具备标准语义、静默丢弃会造成误导的字段会返回 400，包括旧版 `functions` / `function_call`、custom tools、developer role、音频、文件、web search、prediction、logprobs、stop、seed、`n > 1` 和 OpenAI Structured Outputs 的 `json_schema` 模式。纯提示性字段（`reasoning_effort`、`prompt_cache_key`、`prompt_cache_options`、`prompt_cache_retention`、`store`、`metadata`、`service_tier`、`verbosity`、`safety_identifier`、`user`）会被接受并忽略，门户对这些字段没有对应语义，拒绝它们会无谓地阻断 opencode 等真实客户端。

### 工具调用实现

门户不会原生解析 Kimi K3 的工具定义。本适配器采用经过真实接口验证的兼容方案：将 function tools 编译为模型到代理内部的 compact XML 动作协议，并使用 Ajv 按调用方提供的参数 Schema 校验，最后转换为 OpenAI 标准工具响应。代理同时接受旧 verbose XML 历史；工具由调用方执行，代理本身不会执行函数。

支持的选择方式：

- `tool_choice: "auto" | "none" | "required"`；
- 指定函数的 `{ "type": "function", "name": "..." }`，同时兼容传统的嵌套 `function.name` 形状；
- `allowed_tools` 的 `auto` / `required` 子集；
- `parallel_tool_calls: false` 会严格限制为一次最多一个调用。

工具循环遵循 [OpenAI Function calling 指南](https://developers.openai.com/api/docs/guides/function-calling)中的 Chat Completions 流程：把首轮完整的 assistant message 追加到历史，紧接着为其中每个调用追加一条具有相同 `tool_call_id` 的 `role: "tool"` 消息，再发起新的 `/v1/chat/completions` 请求。代理会拒绝遗漏、重复、未知或被其他角色消息打断的工具结果，并把合法的 `assistant.tool_calls` 历史重新编码给 Kimi。

`tool_choice` 是逐请求约束。`required` 要求当前响应必须产生至少一个工具调用，即使历史中已经有工具结果；若要让模型基于结果生成最终答案，下一次请求必须省略 `tool_choice` 或改为 `auto`。工具调用消息可以同时携带简短的用户可见 `content`，但客户端应以 `finish_reason: "tool_calls"` 和完整的 `tool_calls` 数组驱动执行循环，而不能把进度正文当作状态信号。

流式请求会实时转发 `reasoning_content`，但不会把内部 XML 动作暴露给客户端；动作完整且校验通过后才发出 `delta.tool_calls` 和 `finish_reason: "tool_calls"`。若模型生成无效 XML、未知工具或不符合 Schema 的参数，非流式请求返回 HTTP 502 `invalid_tool_action`；流式响应已经开始后则通过 SSE error 事件结束。XML 只存在于模型到代理的内部边界，不等同于上游推理框架原生的 `kimi_k3` tool parser。

当上游明确以 `finish_reason: "length"` 截断时，代理会为 `response_format: text` 响应和尚未形成合法工具动作的工具请求，最多发起 10 次内部续轮；工具协议产生无效动作时，模型纠错最多连续重试 5 次。续轮只使用已公开的 `reasoning_content` 和 `content`，不可能恢复模型的隐藏推理状态。代理保留完整初始请求，并按实际发送顺序追加每个 `assistant -> user` 重试对，使下一次上游请求成为前一次请求的严格前缀，以便上游提示缓存复用；客户端回传带有 `reasoning_content` 的历史时，也会据此还原同一组实际重试消息。每次上游请求仍复用该请求的有效 `max_tokens` 上限，流式客户端会收到一个连续的 SSE 响应及累计 usage。`response_format: json_object` 保持单次响应语义，不自动拼接截断 JSON；第 11 次连续截断时，文本响应最终保留 `finish_reason: "length"`，工具请求返回 `tool_action_length_exceeded`。

账号按轮询使用。只有在上游尚未开始推理且明确是会话认证失败时，代理才会刷新登录或切换下一个账号；流式数据开始、超时或未知请求状态不会自动重发。

## 验证

```powershell
pnpm test
pnpm run build
```

`tests/` 覆盖请求字段校验、token 映射、工具协议、参数 Schema、JSON 归一化和 SSE 归一化。真实账号登录应通过面板手动触发，凭据不会放入测试文件。
