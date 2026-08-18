import { defineEventHandler, setResponseHeader } from "h3"
import { getDebugScript } from "../utils/management-page"

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "content-type", "text/javascript; charset=utf-8")
  return getDebugScript()
})
