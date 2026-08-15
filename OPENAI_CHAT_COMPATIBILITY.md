# Neuralwatt /api/chat OpenAI Chat Completions 兼容性测试报告

## 1. 结论摘要

本报告记录了对 https://portal.neuralwatt.com/api/chat 的登录态测试。测试请求由已登录的 Neuralwatt Playground 页面发起，模型为 kimi-k3，然后在浏览器内对实际请求体做最小字段改写并继续发送。

结论不是“完全兼容 OpenAI v1/chat/completions”，而是：

1. 基础文本聊天、流式 SSE、非流式 JSON、system/assistant/tool/function 历史、文本 content parts、真实图片输入和普通 JSON Object 输出可用。
2. 网关对大量字段采取宽松接受策略。HTTP 200 只代表请求被放行，不代表字段语义生效；本轮已用成对和反例把多数字段分为“生效”“被忽略”或“只能观察到接受”。
3. `max_tokens` 才是当前 Kimi K3 路径的实际输出上限；同时发送时它覆盖 `max_completion_tokens`，后者不能直接映射。
4. `json_schema` 的 JSON 外形可以返回，但 `strict`/enum 约束没有执行；冲突提示下仍返回了 schema 禁止的值。
5. 标准工具调用、web search、moderation、文件输入、音频输入/输出、缓存、prediction、n>1、logprobs 和 developer role 当前不能按 OpenAI 语义使用。
6. `stop`、`seed`、`service_tier`、`reasoning_effort`、`stream_options` 等字段会被接受，但对当前响应没有观察到标准语义；service tier 始终回显 `standard`。
7. developer role 会导致 SSE 内嵌错误，网页显示 Gateway returned status 400；传输层本身仍可能是 HTTP 200。
8. n: 2 的流式和非流式测试都只观察到一个 choice（index 0），不能按标准多候选语义使用。

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

- 测试时间：2026-08-16 00:54-01:46（UTC+08:00）
- 页面：https://portal.neuralwatt.com/playground
- 后端路径：https://portal.neuralwatt.com/api/chat
- 模型：kimi-k3
- 用例数量：原始基线 40 个 + 本轮 65 个有效补充捕获（并行拦截失败样本未计入）
- 登录方式：使用浏览器已有登录状态；未读取或输出 Cookie、Authorization、账户标识和会话存储

当前 Neuralwatt 文档页面展示的公开 API 示例路径是 https://api.neuralwatt.com/v1/chat/completions。本报告测试的是门户页面使用的 /api/chat，两者是不同路径和不同认证上下文，不能因为名字相似就认为可以直接互换。标准字段基准采用 [OpenAI Chat Completions create reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)；该页面明确说明参数支持还可能随模型变化。

### 2.4 关于“全部功能”的边界

本报告已经覆盖 Chat Completions `create` 请求的全部公开 body 参数类别和消息 content 类型。OpenAI 当前参考还列出 chat completion 的 retrieve、update、delete、list 等资源操作；门户页面实际观察到的是单一 POST `/api/chat` 生成入口，没有可安全关联的 completion ID 或对应资源路由，因此这些资源管理操作不能从本 endpoint 推断为支持，也没有执行删除或更新请求。Responses、Files、Audio、Moderations 等独立产品接口同样不可能通过 `/api/chat` 的 body 映射得到，仍按第 2.2 节列为未测试/不适用。

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
| max_tokens | 支持 | 低上限产生 finish_reason: length；与 max_completion_tokens 同时发送的对照中，实际 completion_tokens 分别受 32 和 256 的 max_tokens 控制。 |
| max_completion_tokens | 当前路径不支持标准语义 | 同时发送 max_tokens=256、max_completion_tokens=32 仍生成到 completion_tokens=256；删除 max_tokens 后分别发送 32/256 也都得到 completion_tokens=256。应在代理中显式映射或拒绝。 |
| n | 不支持标准多候选语义 | 流式 n: 2 只观察到 choice index 0；非流式 n: 2 的 JSON 也只有一个 choice。 |
| stop | 明确无效迹象 | 无 stop 与 stop: "ZZSTOPZZ" 的同提示对照得到完全相同的 `ALPHAZZSTOPZZOMEGA`，不能依赖该字段。 |
| presence_penalty | 接受但不做标准范围校验 | 发送超出官方范围的 3 仍 HTTP 200；当前没有可靠证据证明惩罚语义生效。 |
| frequency_penalty | 接受但不做标准范围校验 | 发送超出官方范围的 -3 仍 HTTP 200；当前没有可靠证据证明惩罚语义生效。 |
| logit_bias | 接受但无法验证标准效果 | 非空 token map 请求成功，但 provider 没有提供可用生成 token_ids，无法建立可靠的 token 反事实对照；代理不应宣称已支持。 |
| user | 接受但不可从响应验证 | 发送不含敏感信息的测试标识，HTTP 200；该字段若只用于服务端治理/缓存，/api/chat 响应本身无法证明其后台效果。 |
| seed | 不支持确定性语义 | 相同提示、参数和 seed=987654321 的两次请求分别返回 `morning light` 与 `morning sunlight`，usage 也不同。 |
| service_tier | 请求字段被忽略/归一化 | auto/default/flex/scale/priority/fast 以及非法值均 200，所有响应 `service_tier` 都是 `standard`。 |
| stream_options | 当前路径忽略相关语义 | 未发送、`include_usage:false`、`include_usage:true` 三次均只有 1 个非空 usage chunk、0 个 null usage chunk、无 obfuscation。 |
| response_format: text | 支持 | 返回普通文本 SSE。 |
| response_format: json_object | 支持 | 页面显示合法 JSON：{"answer":"JSON_OK"}。 |
| response_format: json_schema | 仅支持 JSON 外形，不支持严格约束 | strict=true 的 enum 只允许 `SCHEMA_ENFORCED`，但冲突提示下仍返回 `{"status":"WRONG_VALUE"}`；不能把它当 Structured Outputs。 |
| modalities: ["text"] | 支持基础传输 | 返回普通文本；没有额外能力可验证。 |
| modalities: ["text","audio"] | 部分支持/音频无效 | HTTP 200 且返回文本，但没有 audio 增量或音频字段。 |
| audio | 不支持当前模型的音频输出 | 发送 voice/format 后只有 text/reasoning delta。 |
| tools | 不支持实际工具调用 | function、custom 工具均被放行，但强制调用、提高 max_tokens 到 512、非流式请求都没有 tool_calls。 |
| tool_choice | 接受但无效 | required、指定函数、allowed_tools.required 都没有产生调用；模型明确说只有内部 thinking 工具。 |
| parallel_tool_calls | 无可用工具语义 | 与 tools 一起发送 true/false 都没有 tool call，无法验证并行控制。 |
| functions | 不支持实际函数调用 | 旧版 functions 请求被接受，但模型明确说没有提供函数。 |
| function_call | 不支持实际函数调用 | 强制指定旧版函数没有产生 function_call 增量。 |
| reasoning_effort | 接受但等级/非法值均无可见标准语义 | none/minimal/low/medium/high/xhigh/max 及非法 `ultra` 均 200；对照输出没有可靠等级差异。 |
| logprobs | 无有效结果 | logprobs: true 请求成功，但 0 个 choice 带非空 logprobs。 |
| top_logprobs | 无有效结果 | 与 logprobs: true、值 5 一起发送，响应仍没有 logprob 数据。 |
| prediction | 请求字段被忽略/无可见加速语义 | prediction 命中和故意错误两种请求都正常返回普通文本；没有 accepted/rejected prediction token 统计或专用响应字段。 |
| store | 接受但无法证明存储 | store=true 成功，但响应没有存储标识，/api/chat 也没有可验证的 retrieve/list 入口。 |
| metadata | 接受但无法证明存储/检索 | metadata 成功但不回显；没有可验证的查询入口。 |
| web_search_options | 不支持 web search 语义 | 高上下文、上海位置请求 200，但模型明确说没有实时信息/搜索能力，也没有引用或搜索事件。 |
| moderation | 请求字段被忽略 | score/block 两种 policy 都 200、正文和 usage 相同，响应没有 moderation 对象。 |
| verbosity | 请求字段被忽略迹象 | low/medium/high 在同一提示、temperature=0 下返回完全相同文本和 usage。 |
| safety_identifier | 接受但无可观测响应语义 | 合成标识请求成功；无回显、隔离或策略变化证据。 |
| prompt_cache_key / prompt_cache_options / prompt_cache_retention | 不支持可观测缓存语义 | key、explicit/30m 断点和 24h retention 均 200；重复请求 `cached_tokens`、`cache_write_tokens` 都为 0。 |

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
| assistant role | 支持 | 带 assistant 历史消息的请求得到 ASSISTANT_OK；audio:null 和 refusal content part 历史也能被接受并继续生成。 |
| tool role | 部分支持 | 带 assistant tool_calls 历史和 tool 结果的消息可被接受并生成文本；没有证明服务能主动产生或执行工具调用。 |
| function role | 部分支持（旧版历史） | 带 function 历史消息的请求成功并得到 FUNCTION_CONTEXT_OK；仅说明历史可读，不说明 function_call 可用。 |
| 普通字符串 content | 支持 | 基础聊天验证。 |
| text content part 数组 | 支持 | content: [{type:"text",...}] 成功得到 TEXT_PART_OK。 |
| image_url content part | 支持基础视觉输入 | 真实生成的 32x32 红色 PNG 在 detail=auto/low/high 下均被回答为 Red，usage 出现 `multimodal_tokens.image=12`；不代表复杂视觉准确率。 |
| input_audio content part | 不支持当前模型能力 | 使用极小静音 WAV 样本，网关返回 200，但模型明确表示是文本助手、不能处理音频。 |
| file content part | 不支持当前模型能力 | 标准 base64 和 data URL 两种 file_data 编码都被 HTTP 200 放行，但模型均明确说没有看到附件；没有 file token 或文件内容证据。 |
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

- function 工具使用 `tool_choice: required`、命名工具和 `allowed_tools.required` 均返回 HTTP 200，但没有 `tool_calls` 增量；
- 将 `max_tokens` 提高到 512 后仍没有调用，模型明确说只有内部 thinking 工具；
- custom tool 也没有产生 custom tool call；
- 非流式强制调用返回一个普通 `chat.completion`，message 虽带有 provider 的 `function_call` 键，但正文明确表示没有可用函数，未观察到实际调用对象；
- 旧版 functions + function_call 也做了同样的强制调用测试，结论一致。

故不能在代理中把“请求体接受 tools”标成工具调用支持。若上游客户端使用 tools，代理应明确返回标准错误，或在文档中声明该能力不可用；不能静默转成普通文本。

## 7. 响应协议形状

### 7.1 流式响应

登录态 stream: true 的网络响应：

- HTTP 状态：200；
- Content-Type：text/event-stream；
- data 对象数量随回答变化；
- 包含 chat.completion.chunk 风格对象；
- 最终有 data: [DONE]；
- 不论是否发送 `stream_options.include_usage`，都只有最后 1 个非空 usage chunk，其余 chunk 没有 usage；
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

`stream_options.include_obfuscation` 也没有产生任何 obfuscation delta。对未发送、false、true 三种请求，响应形状和 usage 行为相同，说明这些选项在当前路径没有可见作用。

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

非流式强制工具调用同样没有返回标准 `tool_calls`；它只返回普通文本 message。非流式响应还包含 provider 扩展键，例如 `prompt_logprobs`、`energy`、`cost` 和 `_latency`，不应直接当作 OpenAI 标准字段依赖。

### 7.3 错误传输

developer role 的错误不是一个干净的 HTTP 4xx：

- 网络层仍观察到 HTTP 200 和 text/event-stream；
- SSE 数据中出现错误值 Gateway returned status 400；
- 页面据此显示网关错误。

这会误导只根据 HTTP 状态判断成功的 OpenAI 客户端。代理层应把 SSE 内嵌错误转换成标准 HTTP 错误状态和标准 error object。

### 7.4 结构化输出反例

请求使用 `response_format.type=json_schema`、`strict=true`，schema 只允许 `status=SCHEMA_ENFORCED`，同时在用户提示中要求 `status=WRONG_VALUE`。服务返回 HTTP 200 SSE 和合法 JSON 外形 `{"status":"WRONG_VALUE"}`。因此当前路径的 json_schema 只是“让模型输出 JSON”的提示性能力，不能提供 OpenAI Structured Outputs 的严格保证。

## 8. 测试用例清单

以下是原始基线用例和本轮补充用例的 ID 与结论。补充捕获用例都通过已登录页面实际发出请求，并在拿到完整响应后才计入；并行拦截产生的 `Invalid InterceptionId` 样本未计入。

| ID | 分类 | 结论 |
| --- | --- | --- |
| response_format-json_object | 结构化输出 | 200 SSE；合法 JSON |
| core-max_completion_tokens | token 上限 | 200；与 max_tokens 对照后确认当前路径实际按 max_tokens 控制 |
| core-stop | stop | 200；停止词后文本仍出现 |
| core-n | 多候选 | 200；页面只显示一个结果 |
| core-penalties | 惩罚项 | 200；效果未做对照 |
| core-seed | seed | 200；补充重复对照确认不提供确定性 |
| core-logit_bias | logit bias | 200；效果未验证 |
| stream-options-usage | stream options | 200；usage 已存在 |
| core-user | user | 200；效果未验证 |
| core-service_tier | service tier | 200；补充各值对照均回显 standard |
| reasoning-effort | 推理参数 | 200；补充官方值及非法值对照无可见等级语义 |
| logprobs | logprobs | 200；没有非空 logprobs |
| response_format-json_schema | JSON Schema | 200；补充冲突反例确认 strict 未执行 |
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
| modern-metadata | metadata/store | 200；无回显或存储可见证据 |
| modern-prediction | prediction | 200；命中/错误对照无专用语义 |
| modern-web-search-options | web search | 200；模型明确无搜索能力 |
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

### 8.1 本轮补充对照用例

| 用例 ID（同一行表示同一测试组） | 结果 |
| --- | --- |
| followup-stop-baseline / followup-stop-controlled | 无 stop 与 `stop="ZZSTOPZZ"` 返回完全相同的 `ALPHAZZSTOPZZOMEGA`；stop 无效迹象 |
| followup-seed-a / followup-seed-b | 相同 seed 的重复请求输出不同，seed 不提供确定性 |
| followup-usage-default / followup-usage-false / followup-usage-true | 三次均 1 个非空 usage、0 个 null usage、0 个 obfuscation；stream_options 语义被忽略 |
| followup-reasoning-none/minimal/low/medium/high/xhigh/max/invalid | 官方值和非法 `ultra` 都 200；无可靠等级差异 |
| followup-service-tier-auto/default/flex/scale/priority/fast/unsupported-tier | 全部 200，响应 service_tier 均为 `standard` |
| followup-verbosity-low/medium/high-retry | 同一提示下正文和 usage 完全相同；verbosity 无可见作用 |
| followup-cache-baseline / followup-cache-key / followup-cache-explicit-1 / followup-cache-explicit-2 / followup-prompt-cache-retention | 均 200；重复显式缓存请求的 cached_tokens 和 cache_write_tokens 均为 0 |
| followup-safety-identifier / followup-metadata / followup-store | 均 200；无回显、持久化或隔离的可见证据 |
| followup-prediction-exact / followup-prediction-mismatch | 命中与错误 prediction 都返回普通文本；无 prediction token 统计或加速证据 |
| followup-moderation-score / followup-moderation-block | 正文、usage 相同且 moderation 对象数为 0；字段被忽略迹象 |
| followup-file-content / followup-file-data-url | 两种 file_data 编码都被放行，但模型均说没有附件 |
| followup-vision-red-square / followup-image-detail-auto / followup-image-detail-low | 红色 PNG 均识别为 Red，image token 计数为 12；基础视觉输入可用 |
| followup-tool-required / followup-tool-named / followup-allowed-tools-required / followup-custom-tool-required / followup-tool-required-512 / followup-tool-required-nonstream | 强制 function/custom/allowed tool 均无 tool_calls；流式和非流式一致 |
| followup-schema-strict-conflict / followup-schema-nonstrict-conflict | strict 与 nonstrict 都返回 schema 禁止的 WRONG_VALUE；严格 schema 不生效 |
| followup-max-tokens-wins / followup-max-completion-wins / followup-max-completion-only-32 / followup-max-completion-only-256 | 同传两个长度字段时分别按 max_tokens=32/256 截断；删除 max_tokens 后 max_completion_tokens=32/256 都得到 completion_tokens=256，说明该字段被忽略 |
| followup-invalid-temperature / followup-invalid-top-p / followup-invalid-presence-penalty / followup-invalid-frequency-penalty | 超出官方范围仍 HTTP 200，网关不做严格参数校验 |
| followup-assistant-audio-null / followup-assistant-refusal-part | assistant audio:null 和 refusal content part 历史可读并能继续生成 |
| followup-web-search-options | 200，但模型明确无实时搜索能力，无引用或搜索结果 |
| raw-logit-baseline | provider choice 中没有可用生成 token_ids，无法建立可靠的 logit_bias token 反事实对照 |

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
response_format: text/json_object
text content parts
image_url content parts（仅基础验证）
~~~

`max_completion_tokens` 不能直接透传：代理需要把它转换为 `max_tokens`，并定义两个字段同时存在时的冲突策略。`json_schema` 只能作为“尽量输出 JSON”的请求转发，不能承诺 strict schema；需要严格结构时应在代理侧校验并在失败时返回标准错误。

### 9.2 代理必须做的转换

1. 将外部 /v1/chat/completions 路径映射到门户 /api/chat，不要假设门户自动提供标准路径。
2. stream:true 时过滤或容忍 SSE 注释，保留标准 id/object/created/model/choices/usage，并决定是否移除 provider 专用键。
3. reasoning、prompt_token_ids、token_ids、stop_reason 等扩展放入可选扩展，不能让严格 OpenAI 客户端依赖它们。
4. stream:false 时直接返回规范 JSON；不要让调用方误以为网页的 SSE 解析器也能处理它。
5. 把 SSE 内嵌错误转换成 HTTP 4xx/5xx 和标准 error object。
6. 对 tools、functions、developer、logprobs、音频、文件、web search、moderation、prompt cache、prediction 和 n>1 显式拒绝，或在兼容层文档中清楚标为 unsupported；不要静默返回成功后让调用方误判。
7. 对 max_tokens 与 max_completion_tokens 做自己的映射和冲突校验；当前上游只按 max_tokens 控制。
8. 对 json_schema 做本地 schema 校验；上游 strict 不可靠，不能把返回的 JSON 外形当作约束通过。
9. 不要把浏览器 Cookie 转发给外部 API 调用者。代理应在服务端管理登录态或使用正式 API key，并隔离用户会话。

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
- 严格 JSON Schema、prompt caching、Predicted Outputs 或 moderation 结果。

## 10. 限制、未决问题和后续验证

1. 本轮只测试 kimi-k3，不能代表 Kimi K3 Fast 或其他模型。
2. 本轮使用一个已登录浏览器会话，没有验证正式 API key 的 Authorization 流程、跨用户隔离、匿名访问、配额和限流。
3. 没有进行压力测试、长上下文极限、并发、断线重连、取消请求或重试语义测试。
4. penalty 和 logit bias 的具体 token 分布影响仍无法从少量黑盒请求可靠量化；本轮已确认越界值也不被网关拒绝。
5. 图片已用真实 32x32 红色 PNG 复核 auto/low/high，但不能替代复杂视觉准确率、URL 图片和大图压力测试。
6. 音频输入使用极小静音 WAV，结果反映当前模型链路不能处理音频，不代表其他模型一定相同。
7. `user`、`safety_identifier`、`store`、`metadata` 等主要影响服务端治理或持久化的字段，黑盒响应无法证明后台是否记录；报告只给出客户端可观测结论。
8. OpenAI 当前参考页面可直接访问，字段清单以该官方 create reference 为基准；官方文档也提示参数支持可能随模型变化。
9. 本报告没有把浏览器中的任何账户标识、Cookie、Authorization 头或内部身份值写入文件；也没有导出登录凭据。

## 11. 最终判断

对于“把标准 OpenAI v1/chat/completions 转发到 Neuralwatt /api/chat”这个目标：

- 基础聊天代理：可以实现；
- 流式文本代理：可以实现，但需要 SSE 兼容处理；
- 非流式文本代理：后端可以实现，需单独处理 JSON；
- JSON Object 代理：可以实现；
- JSON Schema 代理：只能做非严格转发，严格约束需代理侧校验；
- 基础图片输入代理：可以试用，但应标注验证范围；
- 完整 OpenAI Chat Completions drop-in：目前不能声称；
- 工具调用、developer role、logprobs、n>1、音频、文件、web search、moderation、prompt cache、prediction：当前实测不应宣称支持。

最稳妥的生产策略是建立一个“支持子集 + 显式拒绝列表”的适配层，而不是把所有外部字段原样透传。
