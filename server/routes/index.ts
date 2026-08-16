import { eventHandler, sendRedirect } from "h3"

// Learn more: https://nitro.build/guide/routing
export default eventHandler((event) => {
  return sendRedirect(event, "/index.html")
});
