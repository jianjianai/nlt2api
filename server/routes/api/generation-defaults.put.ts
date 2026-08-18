import { defineEventHandler } from "h3"
import { requireAdmin } from "../../v2/http/auth"
import { readJsonBody } from "../../v2/http/body"
import { sendApiError } from "../../v2/http/errors"
import { allowKeys, objectBody } from "../../v2/http/validation"
import { getRuntime } from "../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["temperature", "maxTokens", "topP"])
    const defaults = await runtime.settings.setGenerationDefaults({
      temperature: body.temperature as number,
      maxTokens: body.maxTokens as number,
      topP: body.topP as number
    })
    return { defaults }
  } catch (error) {
    return sendApiError(event, error)
  }
})
