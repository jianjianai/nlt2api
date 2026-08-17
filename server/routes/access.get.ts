import { defineEventHandler, getQuery, sendRedirect } from "h3"
import { hasWebAccessSession } from "../utils/web-access"

function requestedPage(value: unknown): string {
  return value === "/" || value === "/index.html" ? value : "/"
}

export default defineEventHandler((event) => {
  if (hasWebAccessSession(event)) {
    return sendRedirect(event, requestedPage(getQuery(event).next))
  }

  const next = requestedPage(getQuery(event).next)
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>访问受保护</title>
    <link rel="stylesheet" href="/access.css" />
  </head>
  <body>
    <main class="access-shell">
      <section class="access-card" aria-labelledby="access-title">
        <p class="access-eyebrow">NEURALWATT AI PROXY</p>
        <h1 id="access-title">管理页面受保护</h1>
        <p>请输入网页访问密钥以打开本地管理控制台。</p>
        <form method="post" action="/access">
          <input type="hidden" name="next" value="${next}" />
          <label for="access-key">访问密钥</label>
          <input id="access-key" name="accessKey" type="password" autocomplete="current-password" required autofocus />
          <button type="submit">进入管理页面</button>
        </form>
      </section>
    </main>
  </body>
</html>`
})
