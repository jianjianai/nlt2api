# Neuralwatt /api/chat OpenAI Chat Completions 兼容性测试报告

## 1. 结论摘要

本报告记录了对 https://portal.neuralwatt.com/api/chat 的登录态测试。测试请求由已登录的 Neuralwatt Playground 页面发起，模型为 kimi-k3，然后在浏览器内对实际请求体做最小字段改写并继续发送。

结论不是“完全兼容 OpenAI v1/chat/completions”，而是：

1. 基础文本聊天、流式 SSE、非流式 JSON、系统消息、助手/工具历史、文本内容数组、最小图片输入、JSON Object 和 JSON Schema 输出均可用。
2. 请求体对许多未知或当前未实现字段采取宽松接受策略。HTTP 200 只能说明网关接受了请求，不能说明字段语义生效。
3. 当前链路中，标准工具调用没有真正工作：请求包含 tools、强制 tool_choice 和 parallel_tool_calls 时，响应没有 tool_calls 增量，模型还明确回答当前没有可用函数。
4. developer role 会导致 SSE 内嵌错误，网页显示 Gateway returned status 400；传输层本身仍可能是 HTTP 200。
5. n: 2 的流式和非流式测试都只观察到一个 choice（index 0），不能按标准多候选语义使用。
6. logprobs/top_logprobs 请求被接受，但没有观察到非空 logprobs 数据。
7. 音频输入被接受后，模型明确表示不能处理音频；音频输出请求只返回文本，没有 audio 增量。

因此，/api/chat 可以作为自建 OpenAI 兼容代理的后端之一，但不应作为无条件的 drop-in endpoint。代理必须做字段过滤、错误归一化、SSE/JSON 响应转换，并对不支持的能力显式拒绝。

## 2. 测试范围

### 2.1 本次覆盖

本次将“标准 OpenAI 接口”限定为 Chat Completions 请求和响应契约：

- POST /api/chat 的消息生成请求；
- stream: true 的 SSE 增量响应；
- stream: false 的 JSON 响应；
- 标准消息 role、content parts、采样参数、token 限制、结构化输出、工具字段、可观测性字段和多模态字段；
- 页面实际使用的登录态、模型选择和 System Prompt 行为。

### 2.2 本次不等同于测试的产品

以下 OpenAI 产品接口不在本报告的“全部”范围内，不能从本报告推断其兼容性：

- Responses API；
- Assistants/Threads/Runs；
- Realtime API；
- Embeddings；
- Images、Audio Transcriptions、Audio Speech；
- Moderations、Files、Batches、Fine-tuning；
- Webhook 和账户计费接口。

### 2.3 时间和环境

- 测试时间：2026-08-16 00:54（UTC+08:00 附近，测试持续期间页面时间会有自然变化）
- 页面：https://portal.neuralwatt.com/playground
- 后端路径：https://portal.neuralwatt.com/api/chat
- 模型：kimi-k3
- 用例数量：40 个独立或补充捕获用例
- 登录方式：使用浏览器已有登录状态；未读取或输出 Cookie、Authorization、账户标识和会话存储

当前 Neuralwatt 文档页面展示的公开 API 示例路径是 https://api.neuralwatt.com/v1/chat/completions。本报告测试的是门户页面使用的 /api/chat，两者是不同路径和不同认证上下文，不能因为名字相似就认为可以直接互换。

## 3. 方法和证据规则

1. 先通过可见 Playground 控件选择 kimi-k3，输入测试提示词并提交。
2. 在同一浏览器标签页的网络层捕获页面真实发出的 /api/chat 请求。
3. 只改写请求 JSON 中与当前用例相关的字段，保持浏览器自动管理的登录上下文不变，然后继续请求。
4. 记录 URL 路径、HTTP 状态、Content-Type、SSE/JSON 形状、标准字段是否出现、页面最终显示和错误行为。
5. 测试完成后关闭拦截器，清空临时 System Prompt，恢复 Playground。

### 3.1 结果标记

| 标记 | 含义 |
| --- | --- |
| 支持 | 请求被接受，且通过响应或页面结果验证了该能力的基本语义 |
| 部分支持 | 请求和传输成功，但只验证了部分语义，或存在明显限制 |
| 接受但未验证 | 网关返回成功，但没有足够证据证明字段实际生效 |
| 不支持/无效 | 明确返回错误、没有标准响应字段，或模型明确表示能力不可用 |
| 未测试 | 本轮没有足够的登录态证据，不作推断 |

特别注意：本服务很多字段会被静默忽略。报告中的“200”不是自动等于“支持”。

## 4. 标准请求字段兼容性矩阵

| 字段 | 结果 | 本次证据和限制 |
| --- | --- | --- |
| model | 支持（已验证 Kimi K3） | 页面和改写请求均使用 kimi-k3，响应 model 为 kimi-k3。其他模型没有在本轮逐一验证。 |
| messages | 支持 | 普通 user 消息、历史消息以及多种 role 均可传入；role 细节见第 5 节。 |
| stream | 支持 | true 返回 SSE；false 返回 JSON。两种响应都在登录态下实测。 |
| temperature | 支持基础传输 | 页面默认请求带 0.7，测试中多次改为 0 并正常生成；数值效果未做统计学对照。 |
| top_p | 支持基础传输 | 页面默认请求带 1，与其他测试组合发送并正常生成；采样效果未单独测量。 |
| max_tokens | 部分支持 | 页面默认值可用；低上限会产生 finish_reason: length。与 max_completion_tokens 同时发送时没有严格冲突报错。 |
| max_completion_tokens | 支持基础语义 | 删除 max_tokens 后单独发送 max_completion_tokens: 256，得到预期短回答并以 stop 结束。 |
| n | 不支持标准多候选语义 | 流式 n: 2 只观察到 choice index 0；非流式 n: 2 的 JSON 也只有一个 choice。 |
| stop | 接受但语义无效迹象 | 发送 stop: ["STOP"] 后页面仍显示 ALPHA STOP OMEGA，没有按停止词截断。不能依赖该字段。 |
| presence_penalty | 接受但未验证效果 | 与 frequency_penalty 一起发送，HTTP 200；没有可证明的对照结果。 |
| frequency_penalty | 接受但未验证效果 | 与 presence_penalty 一起发送，HTTP 200；没有可证明的对照结果。 |
| logit_bias | 接受但未验证效果 | 发送非空 token map，HTTP 200；没有对指定 token 的可重复影响证据。 |
| user | 接受但未验证效果 | 发送不含敏感信息的测试标识，HTTP 200；没有观察到响应中的用户关联行为。 |
| seed | 接受但未验证确定性 | 发送固定 seed，HTTP 200；没有执行足够的重复对照来证明确定性。 |
| service_tier | 接受但未验证路由效果 | 发送 service_tier: "auto"，HTTP 200；没有可见 tier 回显或可证明的路由差异。 |
| stream_options | 部分支持 | include_usage: true 请求成功；但未带该字段的流也已经包含 usage，所以没有观察到额外效果。 |
| response_format: text | 支持 | 返回普通文本 SSE。 |
| response_format: json_object | 支持 | 页面显示合法 JSON：{"answer":"JSON_OK"}。 |
| response_format: json_schema | 支持基础语义 | 严格 schema 请求返回 {"status":"SCHEMA_OK","count":1}，页面以代码块显示。更复杂 schema 未测。 |
| modalities: ["text"] | 支持基础传输 | 返回普通文本；没有额外能力可验证。 |
| modalities: ["text","audio"] | 部分支持/音频无效 | HTTP 200 且返回文本，但没有 audio 增量或音频字段。 |
| audio | 不支持当前模型的音频输出 | 发送 voice/format 后只有 text/reasoning delta。 |
| tools | 不支持当前登录态链路中的实际工具调用 | 请求字段被放行，但响应没有 tool_calls，模型明确说没有可用工具。 |
| tool_choice | 接受但无效 | 强制指定函数后仍没有工具调用；单独发送 "none" 能正常生成普通文本。 |
| parallel_tool_calls | 未实现可用工具语义 | 与 tools 一起发送 false，没有 tool call 可供并行控制。 |
| functions | 不支持实际函数调用 | 旧版 functions 请求被接受，但模型明确说没有提供函数。 |
| function_call | 不支持实际函数调用 | 强制指定旧版函数没有产生 function_call 增量。 |
| reasoning_effort | 接受但等级效果未验证 | low 请求成功；响应包含 provider 的 reasoning 增量，但没有对比不同等级。 |
| logprobs | 无有效结果 | logprobs: true 请求成功，但 0 个 choice 带非空 logprobs。 |
| top_logprobs | 无有效结果 | 与 logprobs: true、值 5 一起发送，响应仍没有 logprob 数据。 |
| prediction | 接受但未验证推测加速 | 请求成功，普通回答正常；没有观察到 prediction 命中或专用响应字段。 |
| store | 接受但未验证存储行为 | 发送 store: false，请求成功；没有查询或持久化证据。 |
| metadata | 接受但未验证存储/检索行为 | 发送测试 metadata，响应正常；没有回显或查询证据。 |
| web_search_options | 接受但未验证搜索行为 | 发送低上下文搜索选项，响应正常；没有搜索调用、引用或联网证据。 |

### 4.1 页面实际基线请求

未改写时，Playground 对 /api/chat 发送的核心 JSON 字段为：

~~~json
{
  "model": "kimi-k3",
  "messages": [
    {"role": "user", "content": "..."}
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 2048,
  "top_p": 1
}
~~~

页面请求使用浏览器登录上下文；本次没有把浏览器 Cookie 或页面内部身份头复制到报告中。

## 5. 消息 role 和 content 兼容性

| 消息能力 | 结果 | 证据 |
| --- | --- | --- |
| system role | 支持 | 注入 system + user 后得到 SYSTEM_OK；可见 System Prompt 控件也确实使真实请求出现 system role。 |
| developer role | 不支持 | SSE 传输层为 200，但第一条数据是错误，页面显示 Gateway returned status 400。 |
| user role | 支持 | 所有基础用例均使用并正常返回。 |
| assistant role | 支持 | 带 assistant 历史消息的请求得到 ASSISTANT_OK。 |
| tool role | 部分支持 | 带 assistant tool_calls 历史和 tool 结果的消息可被接受并生成文本；没有证明服务能主动产生或执行工具调用。 |
| function role | 部分支持（旧版历史） | 带 function 历史消息的请求成功并得到 FUNCTION_CONTEXT_OK；仅说明历史可读，不说明 function_call 可用。 |
| 普通字符串 content | 支持 | 基础聊天验证。 |
| text content part 数组 | 支持 | content: [{type:"text",...}] 成功得到 TEXT_PART_OK。 |
| image_url content part | 部分支持 | 1x1 PNG data URI 请求成功并得到 VISION_OK；只验证最小协议和响应路径，没有做复杂图像准确率测试。 |
| input_audio content part | 不支持当前模型能力 | 使用极小静音 WAV 样本，网关返回 200，但模型明确表示是文本助手、不能处理音频。 |
| 消息 name | 部分验证 | 旧版 function role 用例包含 name 并成功；没有对每一种 role 的 name 语义单独验证。 |

## 6. 工具调用专项结果

实际发送的现代工具请求包含：

~~~json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": {
    "type": "function",
    "function": {"name": "get_weather"}
  },
  "parallel_tool_calls": false
}
~~~

观察结果：

- HTTP 传输返回 200 SSE；
- SSE 增量字段只有 role、content、reasoning；
- tool_calls 增量数量为 0；
- finish reason 为 stop；
- 模型文本表示没有可用的 get_weather 函数。

旧版 functions + function_call 也做了同样的强制调用测试，结论一致。故不能在代理中把“请求体接受 tools”标成工具调用支持。若上游客户端使用 tools，建议代理明确返回标准错误，或在文档中声明该能力不可用。

## 7. 响应协议形状

### 7.1 流式响应

登录态 stream: true 的网络响应：

- HTTP 状态：200；
- Content-Type：text/event-stream；
- data 对象数量随回答变化；
- 包含 chat.completion.chunk 风格对象；
- 最终有 data: [DONE]；
- usage 通常存在；
- delta 中观察到 role、content、reasoning；
- provider 还附带 token ids、stop reason 等字段。

捕获到的标准和 provider 扩展顶层键包括：

~~~text
id
object
created
model
choices
prompt_token_ids
prompt_text
service_tier
usage
system_fingerprint
~~~

choice 键包括：

~~~text
index
delta
logprobs
finish_reason
token_ids
stop_reason
~~~

响应中还出现了 SSE 注释行形式的 pricing 和 energy 信息。SSE 注释本身通常可被标准解析器忽略，但非标准 JSON 键和 reasoning delta 需要代理或客户端采取宽容解析策略。

### 7.2 非流式响应

登录态 stream: false 的网络响应：

- HTTP 状态：200；
- Content-Type：application/json；
- object 为 chat.completion；
- choices 有一个元素；
- message 包含 role、content、function_call、reasoning 键；
- usage 存在；
- 实际内容捕获为 NONSTREAM_RESPONSE_OK。

这说明后端有非流式 JSON 响应，但当前 Playground 客户端按流式读取器处理页面请求；改写为 stream:false 后页面没有正常显示正文，指标也显示为 0。自建代理应根据客户端请求的 stream 值分别处理，不能简单复用 Playground 的解析逻辑。

### 7.3 错误传输

developer role 的错误不是一个干净的 HTTP 4xx：

- 网络层仍观察到 HTTP 200 和 text/event-stream；
- SSE 数据中出现错误值 Gateway returned status 400；
- 页面据此显示网关错误。

这会误导只根据 HTTP 状态判断成功的 OpenAI 客户端。代理层应把 SSE 内嵌错误转换成标准 HTTP 错误状态和标准 error object。

## 8. 40 个测试用例清单

以下是本轮实际执行的用例 ID 和结论。补充捕获用例用于读取响应 body 结构，不代表重复计费功能。

| ID | 分类 | 结论 |
| --- | --- | --- |
| response_format-json_object | 结构化输出 | 200 SSE；合法 JSON |
| core-max_completion_tokens | token 上限 | 200；短回答成功 |
| core-stop | stop | 200；停止词后文本仍出现 |
| core-n | 多候选 | 200；页面只显示一个结果 |
| core-penalties | 惩罚项 | 200；效果未做对照 |
| core-seed | seed | 200；确定性未验证 |
| core-logit_bias | logit bias | 200；效果未验证 |
| stream-options-usage | stream options | 200；usage 已存在 |
| core-user | user | 200；效果未验证 |
| core-service_tier | service tier | 200；路由未验证 |
| reasoning-effort | 推理参数 | 200；等级差异未验证 |
| logprobs | logprobs | 200；没有非空 logprobs |
| response_format-json_schema | JSON Schema | 200；严格 schema 输出成功 |
| response_format-text | 文本模式 | 200；文本成功 |
| tools-forced-function | 现代工具 | 200；没有 tool call |
| legacy-functions-forced | 旧版函数 | 200；没有 function call |
| messages-system-role | system role | 200；遵循指令 |
| messages-developer-role | developer role | SSE 内嵌 400 错误 |
| messages-assistant-history | assistant 历史 | 200；历史可用 |
| messages-tool-history | tool 历史 | 200；历史可读 |
| content-text-array | 文本 parts | 200；成功 |
| content-vision-image_url | 图片输入 | 200；最小请求成功 |
| content-input-audio | 音频输入 | 200；模型不能处理 |
| modalities-audio-output | 音频输出 | 200；只有文本 |
| stream-false | 非流式 | 200 JSON；后端成功，页面解析不匹配 |
| modern-metadata | metadata/store | 200；存储行为未验证 |
| modern-prediction | prediction | 200；命中效果未验证 |
| modern-web-search-options | web search | 200；未观察到搜索 |
| modern-modalities-text | text modality | 200；文本成功 |
| detail-n-and-stop | n/stop body | 200；仅 index 0，stop 无效迹象 |
| detail-stream-false | 非流式 body | 标准 JSON；正文可读 |
| validation-token-limit-conflict | 参数冲突 | 200；未严格校验 |
| validation-invalid-response-format | 非完整 schema | 200；未严格校验 |
| tool-choice-without-tools | tool_choice 单独发送 | 200；普通文本 |
| response-shape-sse | SSE 结构 | 200；标准 + provider 扩展 |
| detail-tools-response | 工具响应 body | 无 tool_calls |
| detail-logprobs | logprobs body | 0 个非空 logprobs |
| detail-n-nonstream | 非流式 n=2 | choices 数量为 1 |
| messages-function-role | function 历史 | 200；历史可读 |
| detail-developer-error | developer 错误 body | HTTP 200 SSE 内嵌错误 |

## 9. 对 OpenAI 兼容代理的建议

### 9.1 可以直接映射的最小子集

以下字段在本轮有足够证据作为代理的“兼容基础子集”：

~~~text
model
messages: system/user/assistant/tool/function history
stream
temperature
top_p
max_tokens
max_completion_tokens
response_format: text/json_object/json_schema
text content parts
image_url content parts（仅基础验证）
~~~

### 9.2 代理必须做的转换

1. 将外部 /v1/chat/completions 路径映射到门户 /api/chat，不要假设门户自动提供标准路径。
2. stream:true 时过滤或容忍 SSE 注释，保留标准 id/object/created/model/choices/usage，并决定是否移除 provider 专用键。
3. reasoning、prompt_token_ids、token_ids、stop_reason 等扩展放入可选扩展，不能让严格 OpenAI 客户端依赖它们。
4. stream:false 时直接返回规范 JSON；不要让调用方误以为网页的 SSE 解析器也能处理它。
5. 把 SSE 内嵌错误转换成 HTTP 4xx/5xx 和标准 error object。
6. 对 tools、functions、developer、logprobs、音频和 n>1 显式拒绝，或在兼容层文档中清楚标为 unsupported；不要静默返回成功后让调用方误判。
7. 对 max_tokens 与 max_completion_tokens 做自己的冲突校验，因为上游没有严格拒绝。
8. 不要把浏览器 Cookie 转发给外部 API 调用者。代理应在服务端管理登录态或使用正式 API key，并隔离用户会话。

### 9.3 不应做的承诺

在没有额外验证前，不应宣称以下能力已支持：

- 函数执行或自动工具循环；
- 多候选 n；
- token logprobs；
- 音频输入/输出；
- developer role；
- web search；
- metadata/store 的持久化；
- seed 的确定性；
- service tier 的计费或路由保证。

## 10. 限制、未决问题和后续验证

1. 本轮只测试 kimi-k3，不能代表 Kimi K3 Fast 或其他模型。
2. 本轮使用一个已登录浏览器会话，没有验证正式 API key 的 Authorization 流程、跨用户隔离、匿名访问、配额和限流。
3. 没有进行压力测试、长上下文极限、并发、断线重连、取消请求或重试语义测试。
4. seed、penalty、logit bias、reasoning effort、service tier、prediction、metadata 和 store 只验证了请求接受，尚未做严格的成对统计或持久化验证。
5. 图片测试使用 1x1 PNG，仅验证最小请求路径；不能替代真实视觉准确率测试。
6. 音频输入使用极小静音 WAV，结果反映当前模型链路不能处理音频，不代表其他模型一定相同。
7. 官方 OpenAI 当前参考页面本轮无法稳定访问（官方页面在浏览器中返回 403，搜索回源返回 424）。因此字段清单按 Chat Completions 的标准契约和实测结果整理；部署前应再次对照官方当前 schema。
8. 本报告没有把浏览器中的任何账户标识、Cookie、Authorization 头或内部身份值写入文件。

## 11. 最终判断

对于“把标准 OpenAI v1/chat/completions 转发到 Neuralwatt /api/chat”这个目标：

- 基础聊天代理：可以实现；
- 流式文本代理：可以实现，但需要 SSE 兼容处理；
- 非流式文本代理：后端可以实现，需单独处理 JSON；
- JSON Object/JSON Schema 代理：可以实现；
- 基础图片输入代理：可以试用，但应标注验证范围；
- 完整 OpenAI Chat Completions drop-in：目前不能声称；
- 工具调用、developer role、logprobs、n>1、音频：当前实测不应宣称支持。

最稳妥的生产策略是建立一个“支持子集 + 显式拒绝列表”的适配层，而不是把所有外部字段原样透传。
