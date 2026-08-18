import { defineEventHandler, readBody, sendRedirect, setResponseStatus } from "h3"
import { clearWebAccess, unlockWebAccess } from "../utils/web-access"

function requestedPage(value: unknown): string {
  return value === "/" || value === "/index.html" || value === "/debug" || value === "/debug.html" ? value : "/"
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ accessKey?: unknown; next?: unknown }>(event)
  const accessKey = typeof body?.accessKey === "string" ? body.accessKey : ""
  const next = requestedPage(body?.next)

  if (!unlockWebAccess(event, accessKey)) {
    clearWebAccess(event)
    setResponseStatus(event, 401)
    return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta http-equiv="refresh" content="2;url=/access?next=${encodeURIComponent(next)}"><title>访问被拒绝</title><p>访问密钥无效，正在返回登录页。</p></html>`
  }

  return sendRedirect(event, next)
})
