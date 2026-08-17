import { defineEventHandler, setResponseHeader } from "h3"
import { getManagementScript } from "../utils/management-page"

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "content-type", "text/javascript; charset=utf-8")
  return getManagementScript()
})
