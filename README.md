# Nlt 2 api

这是一个本地/局域网 Nitro 服务，将 OpenAI `v1/chat/completions` 请求转换为 Nlt 门户的 `/api/chat` 请求，并提供账号和会话管理面板。

## 启动

```powershell
pnpm install
pnpm dev
```

首次访问服务时会在终端输出本地代理 Bearer Key。打开 `http://127.0.0.1:3000/`，输入该 Key 后管理账号。

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

门户不会原生解析 Kimi K3 的工具定义。本适配器采用经过真实接口验证的兼容方案：将 function tools 编译为受约束的 JSON 动作协议，强制门户生成 JSON Object，再使用 Ajv 按调用方提供的参数 Schema 校验，最后转换为 OpenAI 标准工具响应。工具由调用方执行，代理本身不会执行函数。

支持的选择方式：

- `tool_choice: "auto" | "none" | "required"`；
- 指定函数的 `{ "type": "function", "name": "..." }`，同时兼容传统的嵌套 `function.name` 形状；
- `allowed_tools` 的 `auto` / `required` 子集；
- `parallel_tool_calls: false` 会严格限制为一次最多一个调用。

工具循环仍遵循 [OpenAI Function calling 指南](https://developers.openai.com/api/docs/guides/function-calling)中的 Chat Completions 流程：把首轮完整的 assistant message 追加到历史，再追加具有相同 `tool_call_id` 的 `role: "tool"` 消息，并在下一次请求中继续携带 `tools`。代理会把历史 `assistant.tool_calls` 重新编码给 Kimi，以便模型读取工具结果并生成最终答案。

流式请求会实时转发 `reasoning_content`，但不会把内部动作 JSON 暴露给客户端；动作完整且校验通过后才发出 `delta.tool_calls` 和 `finish_reason: "tool_calls"`。若模型生成无效 JSON、未知工具或不符合 Schema 的参数，非流式请求返回 HTTP 502 `invalid_tool_action`；流式响应已经开始后则通过 SSE error 事件结束。该方案是模型协议仿真，不等同于上游推理框架原生的 `kimi_k3` tool parser。

账号按轮询使用。只有在上游尚未开始推理且明确是会话认证失败时，代理才会刷新登录或切换下一个账号；流式数据开始、超时或未知请求状态不会自动重发。

## 验证

```powershell
pnpm test
pnpm run build
```

`tests/` 覆盖请求字段校验、token 映射、工具协议、参数 Schema、JSON 归一化和 SSE 归一化。真实账号登录应通过面板手动触发，凭据不会放入测试文件。
