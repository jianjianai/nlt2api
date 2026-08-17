import { defineEventHandler } from "h3"
import { requireManagementAuth } from "../../../utils/auth"
import { sendManagementError } from "../../../utils/errors"
import { fetchPortalModelCatalog } from "../../../utils/portal"
import { saveModelCatalog } from "../../../utils/store"

export default defineEventHandler(async (event) => {
  try {
    await requireManagementAuth(event)
    const catalog = await fetchPortalModelCatalog()
    return { models: await saveModelCatalog({ data: catalog.body.data, scope: catalog.scope }) }
  } catch (error) {
    return sendManagementError(event, error)
  }
})
