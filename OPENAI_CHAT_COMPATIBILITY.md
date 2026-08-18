# Neuralwatt AI v2 OpenAI Chat Compatibility

本文档定义 v2 对外合同。它描述本适配器实际实现的行为，不代表 NeuralWatt 门户原生支持全部 OpenAI 功能。

## 端点

| 方法 | 路径 | 认证 | 行为 |
| --- | --- | --- | --- |
| `GET` | `/health` | 无 | 返回服务状态和 `2.0.0` 版本 |
| `GET` | `/v1/models` | 推理 Bearer Key | 返回标准 `{ object: "list", data: [...] }` |
| `POST` | `/v1/chat/completions` | 推理 Bearer Key | Chat Completions 子集 |

管理 Cookie、bootstrap token 和 CSRF token 不能用于 `/v1/*`。推理 Bearer Key 也不能用于管理 API。

## 请求字段

| 字段 | v2 行为 |
| --- | --- |
| `model` | 必填非空字符串；转发给门户 |
| `messages` | 必填非空数组；严格校验角色、内容与工具事务 |
| `stream` | 可选布尔值；默认 `false` |
| `n` | 省略或 `1`；大于 1 返回 `unsupported_parameter` |
| `temperature` | `0..2` |
| `top_p` | `0..1` |
| `max_tokens` | 正整数；直接作为门户 `max_tokens` |
| `max_completion_tokens` | 正整数；仅在未提供 `max_tokens` 时映射 |
| `modalities` | 只接受 `["text"]` |
| `response_format` | 只接受 `{ "type": "text" }` 或 `{ "type": "json_object" }` |
| `tools` | 只接受 function tools，最多 128 个、合计最多 512 KiB |
| `tool_choice` | `auto`、`none`、`required` 或命名 function |
| `parallel_tool_calls` | 布尔值；`false` 时单轮只能有一个动作 |
| `stream_options.include_usage` | 仅 `stream: true` 时接受；最终 usage 帧位于 `[DONE]` 前 |
| `stream_options.include_obfuscation` | 接受布尔值，但当前不生成 obfuscation 字段 |

`max_tokens` 不会为了工具协议被静默抬高。Agent 多轮调用会从同一个累计 completion token 预算中扣除已报告 usage；预算耗尽返回 `agent_token_budget_exhausted`。

### 接受但忽略

以下字段用于避免阻断常见客户端，但当前不会转发或产生语义：

```text
reasoning_effort
prompt_cache_key
prompt_cache_options
prompt_cache_retention
store
metadata
service_tier
verbosity
safety_identifier
user
```

### 明确拒绝

以下能力没有可靠映射，返回 400，不会静默透传：

```text
functions / function_call
developer role
custom tools
audio input/output
file content
web search
prediction
logprobs / top_logprobs
stop
seed
presence_penalty / frequency_penalty / logit_bias
n > 1
response_format: json_schema
```

未知顶层字段同样返回 `unsupported_parameter`。

## 消息合同

支持 `system`、`user`、`assistant`、`tool` 和旧历史 `function` 角色。

- system/user 必须包含 content；user 可包含文本和 `image_url` parts。
- assistant 在含 `tool_calls` 时可以省略 content 或使用 `null`。
- 每个 `assistant.tool_calls[].id` 在当前事务内唯一。
- tool 消息必须紧跟对应 assistant 工具调用；结果可交换顺序，但不能遗漏、重复、未知或被其他角色打断。
- 历史 `function.arguments` 作为不透明字符串保留；即使旧参数不是合法 JSON，完整事务也可交给模型恢复。
- 新生成的工具动作必须是合法 JSON object，并通过调用方提供的 Schema。

## Function tools

门户不原生返回标准 tool calls，因此 v2 使用内部 JSON Agent 协议：

```text
system
user: 当前任务/继续指令
user: <tool_context>完整工具目录和结束规则</tool_context>
assistant: {"name":"tool_name","arguments":{...}}
tool: 工具执行结果
```

工具上下文只与真实的新任务或继续指令配对。纠错 user 和意图询问 user 后不会再附加工具上下文。

内部模型输出判断：

- 先剥离 `思考内容：` / `回复内容：` 标签；
- `{` 或 `[` 开头表示一个或多个工具动作；
- `<~end~>` 开头表示最终内容；
- 其他文本是状态更新，保留后再询问继续或结束。

Schema 支持未声明版本、draft-06、draft-07、2019-09 和 2020-12。每个工具使用隔离的 Ajv 编译器，重复 `$id` 不会跨工具或跨请求冲突，本地 `$ref` 保持有效。

命名工具会过滤当前可用目录，但不会覆盖调用方显式的 `parallel_tool_calls: true`。`required` 和命名工具必须至少产生一次合法调用，不能直接用 sentinel 结束。

适配器只生成标准调用，不执行客户端函数。合法非流式响应：

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_...",
        "type": "function",
        "function": { "name": "tool_name", "arguments": "{...}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

## 非流式响应

响应标准化为：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 0,
  "model": "requested-model",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "logprobs": null,
    "finish_reason": "stop"
  }],
  "usage": {}
}
```

上游 `reasoning` / `reasoning_content` 作为兼容扩展输出为 `message.reasoning_content`。上游扩展字段、成本和内部路由字段不会透传。

`response_format: json_object` 在普通路径由门户执行；工具 Agent 路径会在 sentinel 之后本地解析，并要求最终值是 JSON object。

## 流式响应

普通文本路径按到达顺序解析门户 SSE 并立即输出标准 `chat.completion.chunk`：

- 保留稳定的 `id`、`created` 和 `model`；
- 只输出标准 delta、`reasoning_content` 扩展和 `finish_reason`；
- 忽略 SSE 注释和 provider 专用字段；
- `include_usage: true` 时，在 `[DONE]` 前输出 `choices: []` 的 usage 帧；
- 上游缺少 `[DONE]` 时输出 `truncated_upstream_stream` 错误帧；
- 客户端取消会中止上游读取。

工具动作必须完成 JSON/Schema 校验才能原子提交，因此动作本身不会逐字符泄漏。普通状态更新可按 Agent 轮次输出。

## 错误

HTTP 失败使用 OpenAI 风格结构：

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "invalid_messages"
  }
}
```

错误类型映射：

| HTTP | type |
| --- | --- |
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 429 | `rate_limit_error` |
| 5xx | `server_error` |

流开始后的上游错误无法改写已提交的 HTTP 状态，会作为单个 SSE `data: {"error":...}` 帧发出并关闭流。

## 账号切换语义

- 401 或明确的会话失效：当前账号最多强制登录一次，再失败才切换账号。
- 首个 SSE 数据事件中的认证错误：在任何客户端数据输出前刷新或切换。
- 429：标记当前账号暂不可用，并尝试下一个启用账号。
- 普通 4xx/5xx、超时、连接中断和未知执行状态：不自动重放，避免重复推理。
- 流一旦交给客户端，不在其他账号上重放。

## 非目标接口

v2 不实现 Responses、Assistants、Threads、Runs、Realtime、Embeddings、Images、Audio、Moderations、Files、Batches 或 Chat Completion 的存储/检索资源接口。
