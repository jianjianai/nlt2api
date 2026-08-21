# NeuralWatt 门户 Playground 上游能力探测

**测试时间：** 2026-08-18 20:58-21:22（北京时间，UTC 12:58-13:22）
**目标：** `https://portal.neuralwatt.com/playground` 及其同源浏览器 API
**方法：** 真实浏览器会话请求、隔离的匿名 HTTP 检查，以及确定性低输出提示。
**机密处理：** 未记录凭据、会话值、API 密钥或 Cookie 值；下文的 Cookie 属性仅保留脱敏元数据。

## 结论摘要

Playground 使用浏览器风格、Cookie 鉴权的接口：

```text
POST https://portal.neuralwatt.com/api/chat
```

其普通请求体和 SSE 分片接近 OpenAI Chat Completions，但它不是原生 OpenAI `/v1` 接口：

- 本次测试中，`POST /api/responses`、`POST /v1/responses`、`POST /v1/chat/completions` 和 `POST /api/v1/chat/completions` 均返回 `404 {"detail":"Not Found"}`。
- 浏览器路由接受 `tools` 和后续的 `role: "tool"` 消息，但工具生成测试没有返回结构化的 `message.tool_calls` 或 `delta.tool_calls`，而是返回模型特有的文本。
- 服务端控制的确定性 JSON 工具信封，配合本地 JSON Schema 校验和合成的标准 `tool_calls`，在六种测试模型上均成功。这是当前适配器采用的稳定方案。

门户文档还描述了 `https://api.neuralwatt.com/v1/...`，包括已入驻账号的 `/v1/responses`。那是独立的 API 主机，不能和本次测试的浏览器 Playground 路由混用。

## 路由矩阵

| 路由 | 观测行为 | 测试的鉴权状态 |
| --- | --- | --- |
| `POST /api/chat` | 类 Chat Completions 的 JSON 或 SSE；浏览器实际使用的上游路由。 | 匿名、已登录 |
| `GET /api/models` | `200 application/json`，返回 `{"models":[...]}`；测试时有 12 个公开模型。 | 匿名、已登录 |
| `GET /api/usage` | `200 application/json`。匿名响应暴露低额度试用配额；已登录 Basic 响应为 `{"rate_limited":false}`。 | 匿名、已登录 |
| `GET /auth/login` | HTML 登录表单。 | 无需状态 |
| `POST /auth/login` | 表单登录；测试账号成功后返回 `303` 到 `/dashboard` 并刷新会话 Cookie。 | 登录流程 |
| `GET /dashboard`（无会话） | `303 See Other`，`Location: /auth/login?next=/dashboard`。 | 匿名 |
| `POST /api/responses` | `404 {"detail":"Not Found"}`。 | 已登录 |
| `POST /v1/responses` | `404 {"detail":"Not Found"}`。 | 已登录 |
| `POST /v1/chat/completions` | `404 {"detail":"Not Found"}`。 | 已登录 |
| `POST /api/v1/chat/completions` | `404 {"detail":"Not Found"}`。 | 已登录 |

测试的 Playground 流程没有观察到 WebSocket；浏览器使用普通 `fetch` 加 HTTP SSE。

## 登录与会话契约

门户登录页是普通 HTML 表单：

```text
POST /auth/login
Content-Type: application/x-www-form-urlencoded

email=<email>
password=<password>
```

- 字段名是 `email` 和 `password`；表单没有可见的隐藏 CSRF 字段。
- 成功登录返回 `303 See Other` 并跳转到 `/dashboard`。
- 测试响应设置 `nw_session=[已脱敏]; HttpOnly; Max-Age=604800; Path=/; SameSite=Lax; Secure`。
- `Max-Age=604800` 是七天，只是本次观测值，不应视为永久保证。
- 未登录时 `GET /dashboard` 的重定向是可靠的会话健康检查。不要用 `POST /api/chat` 检查登录，因为匿名聊天也能成功；会话过期时这样做会悄悄消耗匿名配额。

浏览器以 `credentials: "include"` 发送 `nw_session` Cookie。测试中没有 Authorization Bearer 或 CSRF 请求头。浏览器还发送 `X-Original-Referrer`、`X-UTM-Data` 和 `X-PostHog-ID`；不带这些分析头的同源直连测试也成功，因此它们不是最小契约的一部分。

## 模型目录

`GET /api/models` 无需会话即可返回 `{"models":[...]}`。每个模型对象包含身份、提供商、上下文长度、每 1K token 价格、`supports_tools`、`supports_json_mode`、`supports_vision`、`supports_reasoning`、预览/弹性标志和（适用时）reasoning 能力块。

| ID | 上下文 | 工具 | JSON 模式 | 视觉 | 推理 |
| --- | ---: | :---: | :---: | :---: | :---: |
| `deepseek-v4-flash` | 1,048,576 | 是 | 是 | 否 | 是 |
| `deepseek-v4-pro` | 1,048,576 | 是 | 是 | 否 | 是 |
| `glm-5.2` | 1,048,576 | 是 | 否 | 否 | 是 |
| `glm-5.2-fast` | 1,048,576 | 是 | 否 | 否 | 是 |
| `glm-5.2-short` | 200,000 | 是 | 否 | 否 | 是 |
| `glm-5.2-short-fast` | 200,000 | 是 | 否 | 否 | 是 |
| `gemma-4-31b` | 262,144 | 是 | 是 | 是 | 是 |
| `kimi-k2.7-code` | 262,144 | 是 | 是 | 是 | 是 |
| `kimi-k2.7-code-fast` | 262,144 | 是 | 是 | 是 | 是 |
| `kimi-k3` | 1,048,576 | 是 | 是 | 是 | 是 |
| `kimi-k3-fast` | 1,048,576 | 是 | 是 | 是 | 否 |
| `qwen-3.8-27b` | 262,144 | 是 | 是 | 是 | 是 |
| `qwen3.6-35b` | 131,072 | 是 | 是 | 是 | 是 |
| `qwen3.6-35b-fast` | 131,072 | 是 | 是 | 是 | 否 |

目录中的能力声明只用于选型；工具调用的实际线路行为以下文实测结果为准。

`qwen-3.8-27b`（Qwen3.8-27B，dense 27B VL + MTP 投机解码，FP8）为预览模型，通过 early-access 计划授权：未授权账号的请求返回 404（而非 403），且不出现在匿名 `GET /api/models` 目录中；授权后能力数据以门户模型卡为准（262K 上下文；reasoning effort 默认 `xhigh`，完整档位映射为 max/xhigh/high→xhigh、medium→medium、low/minimal→low、none→none）。

`deepseek-v4-pro`（DeepSeek V4-Pro，Preview）同为预览模型：出现在 Playground 下拉框中，但不出现在 `GET /api/models` 目录（匿名与已登录响应均不含）。2026-08-21 复测确认普通已登录账号可直接调用，无需 early-access 授权：非流式请求正常返回 `finish_reason: "stop"`；reasoning 默认开启（未传 reasoning 参数时 `message.reasoning` 与 `usage.completion_tokens_details.reasoning_tokens` 仍有值）；`max_tokens` 过小时推理会耗尽预算并返回 `finish_reason: "length"`、`content: null`，适配器现有的“仅当 length 截断且内容为空才续写”逻辑可覆盖该情况。JSON 模式支持未在 Playground 声明中标注，暂未实测。适配器对 model 仅做透传且无本地白名单，该模型经代理立即可用，无需代码改动。

## `/api/chat` 请求契约

Playground 每轮发送以下形状。浏览器把会话历史保存在内存中，每轮都重新发送完整消息数组；没有观察到服务端会话或 previous-response ID。

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "可选系统提示" },
    { "role": "user", "content": "消息" }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 2048,
  "top_p": 1
}
```

已确认接受的字段和形式：

- `model` 和 `messages` 必填；缺失时分别返回 `400 {"detail":"Model is required"}` 或 `400 {"detail":"Messages are required"}`。
- `stream: false` 返回非流式、类 Chat Completions JSON；`stream: true` 返回 `text/event-stream; charset=utf-8`。
- 标准 `system`、`user`、`assistant` 和 `tool` 角色均可接受；每轮必须重新提交完整消息数组。
- 输入历史可包含 assistant `tool_calls`、tool `tool_call_id`，以及可选的 `reasoning`/`reasoning_content`。
- 字符串 content 和 OpenAI 内容片段数组均可接受。`gemma-4-31b` 对 1x1 `data:image/png` 产生了非零图像 token 计数；DeepSeek 接受该形状但没有图像 token 指标，与其不支持视觉的目录声明一致。
- Playground 对 `response_format` 的接受不代表它会执行该约束；工具适配不能依赖这个字段，必须使用首条唯一 `system` 消息中的文本契约并在本地校验。
- `tools` 和 `tool_choice` 在语法上都被接受，甚至畸形工具定义也返回成功；不能把这种接受当作上游校验。

上游校验很弱：`temperature: 9`、`max_tokens: 999999` 和畸形工具 Schema 都曾返回 `200`。因此适配器必须在本地校验 OpenAI 输入、JSON Schema、最大生成预算和工具名。

## 普通响应形状

### 非流式

`stream: false` 返回类 Chat Completions 的 JSON（以下为删减后的真实形状）：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1787058198,
  "model": "deepseek-v4-flash",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "NW_NONSTREAM_OK", "function_call": null },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 14,
    "completion_tokens": 7,
    "total_tokens": 21,
    "prompt_tokens_details": { "cached_tokens": 0 }
  },
  "energy": { "energy_joules": 0.94, "energy_kwh": 2.61e-7 },
  "cost": { "request_cost_usd": 0.000004, "cache_savings_usd": 0 }
}
```

实际还遇到 `_latency`、`energy`、`cost`、`service_tier`、`system_fingerprint`、`stop_reason`、`token_ids` 等提供商字段。公开适配器只应有意保留支持的扩展，不要把上游诊断信息意外透传给客户端。

### 流式

普通成功流包含 OpenAI 风格的 `data:` 分片和门户专用 SSE 注释：

```text
: pricing {"prompt_per_1k":0.00014,"completion_per_1k":0.00028}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"NW"},"finish_reason":null}]}

data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}

: energy {"energy_joules":3.01,"energy_kwh":8.37e-7,"duration_seconds":2.81}

data: [DONE]
```

多次流式测试确认：首个注释通常是 `: pricing`，末尾遥测注释是 `: energy`；最后一个 usage 分片的 `choices` 为空，usage 不保证附在 finish 分片上；最后内容后是 `finish_reason: "stop"`，随后 usage、energy 和 `[DONE]`。Playground 客户端会处理 `: routing`，但本次没有实际观察到。

### 错误形状

流式请求不能只看 HTTP 状态：

| 情况 | 观测结果 |
| --- | --- |
| 缺少 `messages` | `400 application/json`，`{"detail":"Messages are required"}` |
| `GET /api/chat` | `405 application/json`，`{"detail":"Method Not Allowed"}` |
| 非流式未知模型 | `404 application/json`；包装体包含 `error` 和文本上游 `details` |
| 流式未知模型 | HTTP 仍为 `200 text/event-stream`，随后 `data: {"error":"Gateway returned status 404","status":404}`；没有正常完成序列 |

因此必须逐条解析 SSE JSON；看到 `error` 之前，不能把传输层 `200` 当作成功。

## 工具调用：门户实际行为

### 可以工作的部分

路由接受常见的输入字段：

```json
{
  "tools": [{ "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object" } } }],
  "tool_choice": "auto"
}
```

也能理解后续的工具结果。下游客户端提交的标准 assistant `tool_calls` 会由网关转换成与受控契约相同的 JSON `content` 后再发往门户：

```json
[
  {
    "role": "assistant",
    "content": "{\"type\":\"tool_calls\",\"tool_calls\":[{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Shanghai\"}}]}"
  },
  {
    "role": "tool",
    "tool_call_id": "nwcall_1",
    "content": "{\"city\":\"Shanghai\",\"temperature_c\":25,\"condition\":\"sunny\"}"
  }
]
```

六种测试模型在下一轮都正确使用了提供的工具结果。

### 不可靠的部分

对 `deepseek-v4-flash`、`glm-5.2-fast`、`gemma-4-31b`、`kimi-k2.7-code-fast`、`kimi-k3-fast` 和 `qwen3.6-35b-fast` 的工具生成测试显示：

- `message.function_call` 始终是 `null`；没有观察到原生 `message.tool_calls` 或流式 `delta.tool_calls`。
- 工具意图只出现在模型文本中，格式随模型和轮次变化，例如：

```text
tool_call(get_weather, city="Shanghai")
get_weather(location="Shanghai")
<tool_call>{"name":"get_weather","arguments":{"location":"Shanghai"}}</tool_call>
<tool_calls><invoke name="get_weather"><parameter name="city">Shanghai</parameter></invoke></tool_calls>
<function_calls><invoke name="get_weather">...</invoke></function_calls>
{"tool_calls":[{"id":"call_1","type":"function",...}]}
```

- Kimi 某次流式输出逐 token 生成 XML 风格的 `<function_calls>`；同一模型其他轮次可能输出 JSON 字面量，甚至输出伪造的天气对象。
- `tool_choice: "none"`、`"auto"`、`"required"` 和固定函数对象都曾继续产生文本标记；不能依赖上游实现策略约束。

门户文档中“工具调用通过 `tool_calls` 数组返回”的说明对应的是文档化的 `api.neuralwatt.com/v1`，不适用于这里实测的浏览器路由。

## 稳定的工具调用适配策略

不要因为任意 prose 看起来像函数调用就执行工具。模型特有的文本解析容易误把示例或普通描述当作调用，无法等价实现 OpenAI 契约。

对每个带工具的请求，使用服务端控制的内部信封：

```json
{
  "type": "tool_calls",
  "preamble": "我先检查当前天气数据源。",
  "tool_calls": [
    { "name": "get_weather", "arguments": { "city": "Shanghai" } }
  ]
}
```

`preamble` 可选，且应只在关键节点出现：做出决定、找到关键线索或根因、计划/阶段变化，或即将执行重要、有风险的操作时。需要输出时应具体、有信息量，而不是笼统的“我要开始…”。常规读取、重试和重复步骤默认省略；如果用户明确要求进度汇报，则只汇报其关心的关键节点。适配器会在完整信封校验通过后释放 `preamble`。

或：

```json
{ "type": "final", "content": "给用户的最终答案。" }
```

服务端系统指令要求上游只能把上述二选一的完整 JSON 输出到普通 assistant `content`，不得输出 Markdown 或 prose；契约中包含工具描述和完整 JSON Schema，但不向门户发送原生 `tools`/`tool_choice`，也不依赖门户不识别的 `response_format` 字段。

本地必须按以下顺序校验：

1. 顶层 `type` 必须严格是 `tool_calls` 或 `final`。
2. `preamble` 若存在必须是字符串，且不得包含内部 marker 或特殊控制 token；不得声称工具已经执行成功。
3. 每个工具名必须存在于客户端声明的工具集合。
4. 每个 `arguments` 对象必须通过对应工具的 JSON Schema。
5. `tool_choice: "none"`、`"required"` 或固定函数由适配器本地执行。
6. JSON 先直接解析；解析失败时用 `jsonrepair` 尝试修复，修复成功直接采用；仍失败时用 `json-source-map`/原生错误位置生成带行、列和上下文片段的友好诊断。工具未知、参数或策略/Schema 失败时同样生成带 `instancePath` 与源位置的友好错误。最多发起五次有界纠错；每次纠错保留第一次响应的 reasoning 字段，替换上一份错误候选。纠错轮的 reasoning 可以立即流式发给客户端，但会带内部标记，并在下一轮上游重放前移除；因此上游只看到首次 reasoning 和最终已校验的工具调用。绝不对任意 prose 做“尽力解析”。

受控信封测试结果：六种模型的首轮均能解析；DeepSeek Flash、GLM Fast 和 Kimi K3 Fast 的双工具请求返回预期数组；网关将信封转换为客户端可见的标准 assistant `tool_calls`，客户端再提交 `role: "tool"` 结果。下一次发往门户时，网关会把这份 assistant `tool_calls` 再编码为受控 JSON `content`，六种模型均返回使用 `25 C` 结果的有效 `{"type":"final",...}`。

最稳妥的线路是省略门户原生 `tools` 和 `tool_choice`。一次后续探测显示：Kimi K3 在契约中提供工具定义且省略原生字段时生成了正确的受控信封；同时发送原生 `tools` 时却切换到内部 `thinking` 工具。Kimi K3 Fast 在受控适配路径中返回了预期信封。这是当前部署的观测值，上游变化后应重新验证。

## 调用循环

对 `/v1/chat/completions`，把客户端消息历史映射为门户 `messages`。

工具轮流程：

1. 将调用方 system/developer 上下文与服务端 JSON 信封契约、函数名和 Schema 合并为唯一的首条 `system` 消息。
2. 不转发门户原生 `tools` 或 `tool_choice`，由适配器本地执行策略。
3. 在最新用户/工具结果之后追加一条仅发往门户的固定 `user` 协议提醒，重复强调本轮必须把工具调用写入 assistant `content`；该提醒不会回传给客户端，且重复构建时会去重。
4. 内部向门户请求缓冲的工具轮。工具契约位于唯一的首条 `system` 消息中，要求模型把 JSON 写入普通 assistant `content`；JSON 未完整到达前不能安全判断是最终答案还是工具调用。
5. 校验信封；工具结果通过后生成标准 OpenAI 工具调用 ID，Chat 返回带可选用户可见 `content`/`preamble` 的 `tool_calls`；`preamble` 始终在工具调用之前释放。
6. 客户端执行自己的工具并在下一轮提交输出；代理不会执行任意客户端工具。
7. 下一轮重建客户端历史，加入标准 assistant `tool_calls` 和各个 `role: "tool"`；发往门户前将 assistant 工具调用及 `preamble` 转换为受控 JSON `content`，并在末尾追加协议提醒，直到得到合法 `final` 或达到本地轮数上限。
8. 客户端要求工具轮流式时，只有在内部解析完成后才合成标准 OpenAI SSE；非工具轮可以直接转发门户 SSE，但要过滤门户注释并检查内嵌错误分片。

必须设置本地上限：工具轮数、单轮工具数、全部参数字节数和工具结果字节数。门户没有展示等价的输入校验。

## 账号池注意事项

每个门户账号必须拥有独立的服务端 Cookie 罐：

```text
按粘性会话键选择账号
  -> 用该账号 Cookie 访问 GET /dashboard
  -> 200：继续使用
  -> 303 到 /auth/login：POST /auth/login，保存刷新后的 Cookie，再检查一次
  -> 失败：使用有界退避标记账号不可用
```

不要用成功的 `/api/chat` 响应证明账号已登录，因为匿名聊天也可能成功。粘性分配应按逻辑 OpenAI 会话/响应链保持，使所有工具轮使用同一上游账号上下文。Cookie 应保存在服务端，绝不能通过管理 API 或消息记录暴露。

## 调试记录边界

管理员调试视图应按一个客户端请求关联原始客户端请求/响应正文、每一次实际门户请求/响应正文、账号 ID、上游状态和受控工具信封及合成工具调用 ID。上游调用必须按首次请求、纠错轮、续写轮和重试顺序完整保留；流式调用必须保存全部原始 SSE 文本，而不能只保存归并后的终态。

持久化或展示前必须脱敏/删除所有鉴权材料：账号密码、`nw_session` 值、任何 `Set-Cookie` 值、Authorization 头、未来可能新增的 CSRF 值和分析标识符。显式开启消息记录后，原始正文仅允许管理员通过“查看原始数据”查看；不应再为调试记录裁剪已接收的消息或工具结果。

## 探测边界

- 结果是当前门户部署的快照，不是提供商的稳定性承诺；路由或模型目录变更前应重新运行冒烟探测。
- 本次没有使用 `api.neuralwatt.com` API Key，因此不对原生 `/v1/responses` 做额外结论，只确认它与门户路由分离。
- 没有故意耗尽速率限制、触发封号或浏览器挑战。
- 为保护隐私，本文只保留少量确定性协议示例，没有复制完整用户提示或模型回复。
