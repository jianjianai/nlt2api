import { defineEventHandler } from "h3"
import { requireManagementAuth } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { getSavedModelCatalog } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireManagementAuth(event)
    return { models: await getSavedModelCatalog() }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
