import { defineEventHandler } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { readJsonBody } from "../../../v2/http/body"
import { sendApiError } from "../../../v2/http/errors"
import { allowKeys, objectBody } from "../../../v2/http/validation"
import { invalidRequest } from "../../../v2/shared/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["enabled"])
    if (typeof body.enabled !== "boolean") {
      throw invalidRequest("enabled must be a boolean", "invalid_request_logging_setting", "enabled")
    }
    return { enabled: await runtime.requestLogs.setEnabled(body.enabled) }
  } catch (error) {
    return sendApiError(event, error)
  }
})
