# Self-Rendered Turnstile Minting via HTML Hijack — Design

日期：2026-08-26
状态：已验证（浏览器实测通过），待生产等同验证与实现

## Background / 动机

当前 `server/utils/deepinfra-turnstile.ts` 的 `DeepInfraTurnstileMinter` 为了获取一次性 Cloudflare Turnstile ticket（`X-DeepInfra-Turnstile`），驱动 DeepInfra **官方页面自身的发送流程**：

1. 每次 mint 导航重载 `https://deepinfra.com/moonshotai/Kimi-K3`；
2. 等待 `textarea[aria-label="chatbot input prompt"]` 与 Send button 就绪；
3. 注入 `SET_PROMPT("ping")`（原生 setter + `input` 事件）；
4. 注入 `CLICK_SEND`（`element.click()` 编程式点击）；
5. 用 CDP `Fetch.enable` 拦截页面发出的 chat 请求，在 headers 里发现 `x-deepinfra-turnstile` 时 `Fetch.failRequest`（Aborted）中止，防止 DeepInfra 赎回 ticket；
6. 摘取 `x-deepinfra-turnstile`、`X-Deepinfra-Source`、`User-Agent` 组装 `TurnstileTicket`。

这套流程的原始设计依据是文件头部注释中的一条结论：

> The ticket is bound to the widget the page itself renders. A self-rendered widget using the same site key is rejected, so we drive the page's own send flow and abort the browser request before it redeems the ticket.

即：**自渲染 widget（即使使用同一 site key）生成的 token 会被 DeepInfra 拒绝**。本次实测表明该结论**在当前 DeepInfra/Turnstile 行为下不再成立**。

## 实测记录

### 前置：获取 site key

抓包 DeepInfra 页面首次加载时的网络请求，获得 Turnstile 脚本与 widget 的 site key：

- 脚本：`https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback&render=explicit`
- **site key：`0x4AAAAAADlBNBTRb73O02Vo`**
- 页面使用 `render=explicit`（手动渲染模式），因此劫持后自渲染在机制上同源。

### 实验 A：真实页面上下文内自渲染（浏览器内手动 render）

在已加载完整 DeepInfra 页面的浏览器里，手动 `turnstile.render('#ts', { sitekey })` 自渲染 widget。

- 结果：**成功产出 token**（`1.FC5G-…`）。
- 用该 token 直接请求 `POST https://api.deepinfra.com/v1/openai/chat/completions`（Kimi-K3，`max_tokens: 4`，带 `Origin` / `Referer` / `X-DeepInfra-Turnstile` / `X-Deepinfra-Source`）：**HTTP 200，返回真实补全**。

混杂因素：该页面此前已通过官方挑战（存在已信任的 widget 实例、可能带 context 信任），不能单独证明"自渲染会被接受"。

### 实验 B：纯净复现 —— 劫持首个 HTML 请求（决定性证据）

用 Playwright `page.route('https://deepinfra.com/**')` 将 `deepinfra.com/` 首个 HTML 文档响应**整体替换**为自渲染页面：

```html
<!doctype html><html><head><meta charset="utf-8"><title>trap</title></head><body>
<div id="ts"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
<script>
  window.addEventListener('load', () => {
    window.turnstile.render(document.getElementById('ts'), {
      sitekey: '0x4AAAAAADlBNBTRb73O02Vo',
      callback: (t) => { window.__token = t; },
      'error-callback': (c) => { window.__err = c; },
    });
  });
</script></body></html>
```

在**全新 browser context（无任何历史信任）**中导航 `deepinfra.com/`：

- 页面标题变为 `trap`，导航无错误 → 劫持成功；
- widget 回调产出 token（`1.2Q0rvh…`）；
- 用该 token 直接请求上述 chat API：**HTTP 200，返回真实补全**（`finish_reason` 正常）。

**结论：劫持首个 HTML 请求 + 页面内自渲染同一 site key 的 Turnstile widget，产物 token 可被 DeepInfra 直接接受。** 原注释中的限制在当前行为下不复存在。

### 实验 C：trap 页面内二次自渲染（复用同页面的新 token）

在实验 B 的 trap 页面（已持有旧 token `1.2Q0rvh…`）上，**不清空页面、直接追加一个新容器并再次 `turnstile.render`**（`#ts2`），取第二个 widget 的 token（`1.UCOnQa2…`）打上游 chat API。

- 结果：**HTTP 200，返回真实补全**（"The user asked me"，`finish_reason: length`）。
- 意义：
  - **同一常驻页面可反复自渲染新 widget 取新 token** —— 与现有 minter 的"常驻浏览器 + 反复 mint"模式天然兼容（当前实现每次 mint 是 `Page.navigate` 重载页面，这里可以验证"不重载、直接 redisplay 新 widget"是否也持续可用）；
  - token 的一次性语义间接确认 —— 旧 token 未复用，每次请求应重新铸票（生产行为要求）。

### 实验 D：token 自然有效期（未使用状态）

做法：在 trap 页面连续 `turnstile.render` 多个 widget 各取一张 token（同页面并存多 widget），记 `mintedAt`；隔不同时长后**首次**用这张 token 打上游 chat API（一次性，用完即弃，不重复使用），观察 200 / 403。

| token（前缀） | 铸后至首次使用年龄 | 上游结果 |
| --- | --- | --- |
| `1.jRIT5zbG9p` | ~0s（基线） | 200 |
| `1.fWBKkxbmOT` | ~90s | 200 |
| `1.0Ja2r2_PLH` | ~90s | 200 |
| `1.LX0HJrX4f3` | ~76s | 200 |
| `1.UOL52Tjv25` | ~125s（2min+） | 200 |
| `1.ENF7KjlqoK` | ~159s（2分39秒） | 200 |
| `1.vYD2y43goY` | **~178s（2分58秒）** | 200 |
| `1.7yrKfOQ4QN` | **~245s（4分05秒）** | **403 Captcha verification failed** |
| `1.dawBKDfH9P` | ~250s | 429 rate_limit（已失效） |

**结论：token 有效窗口约 3 ~ 4 分钟**。铸后 178s（≈3 分钟）仍可被接受，245s（≈4 分钟）已被拒绝（403）。**token 从铸出到过期大约 3~4 分钟**，超过 ~3 分钟使用有失效风险，约 4 分钟必失效。

对生产的启示：ticket 应当**现取现用**（mint 回来后尽快发出请求），当前 `deepInfraChat` 每请求即 mint 的模式天然契合；不要预铸缓存（会过期）。

## 新方案设计：SelfRenderedTurnstileMinter

## 新方案设计：SelfRenderedTurnstileMinter

在不改变外部接口（`mint(): Promise<TurnstileTicket>`、`DeepInfraTurnstilePool`、`deepInfraTurnstileMinter()` 单例）的前提下，替换 minter 内部实现：

```text
spawn(browser, --remote-debugging-port, --user-data-dir, ...)
  → CDP Page.enable + Fetch.enable(pattern: deepinfra.com 主文档)
  → Page.navigate(CHALLENGE_PAGE)
  → Fetch.requestPaused(第一个 HTML) → Fetch.fulfillRequest(自渲染页面, 200 text/html)
  → 页面内 turnstile.render(callback) 产出 token
  → Runtime.evaluate 轮询 window.__token（或 __err）
  → 返回 TurnstileTicket { token, source: "model-embed", mintedAt, userAgent? }
```

关键点：

- **不再需要**：等待聊天控件、`SET_PROMPT` / `CLICK_SEND` 注入、识别并 `Fetch.failRequest` 中止 chat 请求、多轮 `Fetch.continueRequest` 放行。每次 mint 的页面载荷从整个 DeepInfra SPA 降为一个几行 HTML。
- **仍需保留**：常驻浏览器 + warm-up（冷 profile 首次挑战失败）、mint 串行化（一个 widget 一次一个 token）、`DEEPINFRA_TURNSTILE_MINTERS` 多实例池、空闲回收（`idleReleaseMs`，约 1.6GB 内存）、故障自愈（`dropSession` / 重启）。
- **风险点**：`Fetch.fulfillRequest` 的 body 需 base64；响应需正确 `Content-Type: text/html; charset=utf-8`；需要在 `Page.navigate` 发出的首个文档请求上精准命中（pattern `https://deepinfra.com/*`，`requestStage: Request`）；`turnstile.render` 就绪前 api.js 可能未加载（用 `window.turnstile` 轮询或 `render=explicit` + `onload` 回调）。
- **site key 硬编码风险**：当前 site key 从页面抓取得到；若 DeepInfra 更换 site key，自渲染将失效（widget 会报错或产 token 被拒）。建议把 site key 做成可配置项（`DEEPINFRA_TURNSTILE_SITEKEY`），并保留"从真实页面 HTML/iframe 抓取 site key"的后备逻辑，或者保留原驱动流程作为 fallback。

## 待验证（生产等同性）

浏览器实测（Playwright 控制共享浏览器）已通过，但生产 minter 是 `spawn` + raw CDP。上线前需用项目同款方式复现：

1. 用 `spawn` 直启浏览器（含 `--no-sandbox` / SwiftShader / Xvfb 等生产参数）；
2. raw CDP `Fetch.fulfillRequest` 替换 HTML；
3. 连续 mint 多张（如 20 张）逐一直接打上游，统计接受率；
4. 多 minter（默认 2，上限 8）并发下是否稳定；
5. 长时间运行后（profile 信任积累 / IP 变化）是否持续有效；
6. 若 DeepInfra 后续收紧校验（校验 sitekey 与页面一致性等），需回退到原驱动流程 —— 建议实现上保留切换开关。

## 与现有实现对比

| 维度 | 现有（驱动官方页面） | 新方案（劫持 HTML + 自渲染） |
| --- | --- | --- |
| 每次 mint 页面载荷 | 完整 DeepInfra SPA（数百 KB） | 几行 HTML + api.js |
| 页面依赖 | 依赖聊天控件 DOM 结构，改版即坏 | 只依赖 Turnstile 官方 API（稳定） |
| 取 token 方式 | 拦截 chat 请求 + `Fetch.failRequest` 中止 | widget `callback` 直接给 token |
| 复杂度 | 高（注入脚本 × 3 + 请求拦截状态机） | 低（1 次 fulfill + 轮询） |
| 反检测面 | 曾因 Runtime/Console 域、Playwright 特征失败 | 自渲染 widget 同样要求真实渲染管线（SwiftShader/Xvfb 依赖不变） |

## 相关代码位置

- `server/utils/deepinfra-turnstile.ts` — minter / pool / 单例
- `server/utils/deepinfra-client.ts` — `deepInfraChat` 每请求 `mint()` 消费 ticket
- `server/plugins/deepinfra-turnstile.ts` — Nitro close 时关闭 pool
- `server/utils/proxy-sync.ts` — 测活并发受 `DEEPINFRA_TURNSTILE_MINTERS` 限制