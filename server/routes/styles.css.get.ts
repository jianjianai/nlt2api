import { defineEventHandler, setResponseHeader } from "h3"
import { getManagementStyles } from "../utils/management-page"

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "content-type", "text/css; charset=utf-8")
  return getManagementStyles()
})
