import { eventHandler, sendRedirect } from "h3"

// 管理台是 Vue 单页应用，由 /index.html 路由经 server asset 提供，从而受 web-access 中间件保护。
export default eventHandler((event) => {
  return sendRedirect(event, "/index.html")
})
