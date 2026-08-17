import { defineEventHandler, readBody } from "h3"
import { requireWebAccessSession } from "../../utils/auth"
import { sendManagementError } from "../../utils/errors"
import { updateGenerationDefaults } from "../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    const body = await readBody<{ temperature?: unknown; maxTokens?: unknown; topP?: unknown }>(event)
    return {
      defaults: await updateGenerationDefaults({
        temperature: typeof body?.temperature === "number" ? body.temperature : Number.NaN,
        maxTokens: typeof body?.maxTokens === "number" ? body.maxTokens : Number.NaN,
        topP: typeof body?.topP === "number" ? body.topP : Number.NaN
      })
    }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
