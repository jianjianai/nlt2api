# DeepInfra 匿名上游能力

当前唯一上游是 DeepInfra 匿名网页线路：

- 聊天端点：`https://api.deepinfra.com/v1/openai/chat/completions`
- 模型目录：`https://api.deepinfra.com/v1/openai/models`
- 无 Bearer 凭据；每个物理请求使用一次性 `X-DeepInfra-Turnstile` 票据
- 票据单次消费，重复使用返回 403
- 票据不绑定签发 IP，共享铸造器可服务多个出口账号
- 原生支持 OpenAI `tools` / `tool_choice` / 结构化 `tool_calls`
- 支持 JSON 与 SSE；流式可返回连续 usage 统计
- 匿名可用模型由目录中 `chat` 标签且不含 `no-free-anon` 的条目决定
- 价格位于 `metadata.pricing`，单位为每百万 token

## 浏览器边界

挑战拒绝无头浏览器和 Playwright 驱动启动。网关直接启动 Chrome/Edge，并通过裸 CDP 驱动 DeepInfra 自己的页面发送流程；浏览器请求在提交前被中止，票据由网关的 HTTP 请求消费。

Linux 服务器使用 Xvfb 提供虚拟显示，并显式启用 SwiftShader。没有 WebGL 时挑战不出票；启用 SwiftShader 后已在 xigong2 上连续实测通过。

## 参数

已验证支持：`temperature`、`top_p`、`top_k`、`stop`、`seed`、`presence_penalty`、`frequency_penalty`、`repetition_penalty`、`response_format`、`parallel_tool_calls`、`tool_choice`、`user`、`metadata`、`reasoning_effort`、`n=1`、`logprobs`。`stream_options` 仅可与 `stream: true` 同用。

`min_p` 和 `logit_bias` 在当前推测解码路径上会被上游拒绝，因此网关不转发这两个字段。

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
