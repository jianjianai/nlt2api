import { defineEventHandler, setResponseHeader } from "h3"
import { getDebugStyles } from "../utils/management-page"

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "content-type", "text/css; charset=utf-8")
  return getDebugStyles()
})
