# Neuralwatt AI Proxy

这是一个本地/局域网 Nitro 服务，将 OpenAI `v1/chat/completions` 请求转换为 Neuralwatt 门户的 `/api/chat` 请求，并提供账号和会话管理面板。

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

已确认不具备标准语义的字段会返回 400，包括工具调用、developer role、音频、文件、web search、prediction、prompt cache、logprobs、stop、seed、`n > 1` 和 JSON Schema 严格约束。

账号按轮询使用。只有在上游尚未开始推理且明确是会话认证失败时，代理才会刷新登录或切换下一个账号；流式数据开始、超时或未知请求状态不会自动重发。

## 验证

```powershell
pnpm test
pnpm run build
```

`tests/` 覆盖请求字段校验、token 映射、JSON 归一化和 SSE 归一化。真实账号登录应通过面板手动触发，凭据不会放入测试文件。
