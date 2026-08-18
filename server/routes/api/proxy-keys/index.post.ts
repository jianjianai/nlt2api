import { defineEventHandler } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { readJsonBody } from "../../../v2/http/body"
import { sendApiError } from "../../../v2/http/errors"
import { allowKeys, objectBody } from "../../../v2/http/validation"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["label"])
    const created = await runtime.inferenceKeys.create(body.label as string)
    return { key: created.apiKey, secret: created.secret }
  } catch (error) {
    return sendApiError(event, error)
  }
})
