import { defineEventHandler, setResponseHeader } from "h3"
import { getManagementPage } from "../utils/management-page"

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "content-type", "text/html; charset=utf-8")
  return getManagementPage()
})
