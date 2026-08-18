import { defineEventHandler, getQuery } from "h3"
import { requireWebAccessSession } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { debugPageNumber, debugPageSize, listDebugTraces } from "../../../utils/debug-history"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    const query = getQuery(event)
    return listDebugTraces(debugPageNumber(query.page), debugPageSize(query.pageSize))
  } catch (error) {
    return sendManagementError(event, error)
  }
})
