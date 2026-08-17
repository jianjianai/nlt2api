import { defineEventHandler } from "h3"
import { requireWebAccessSession } from "../../utils/auth"
import { sendManagementError } from "../../utils/errors"
import { getGenerationDefaults } from "../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    requireWebAccessSession(event)
    return { defaults: await getGenerationDefaults() }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
