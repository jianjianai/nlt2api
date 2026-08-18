import { defineEventHandler, getRouterParam } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { sendApiError } from "../../../v2/http/errors"
import { ApiError } from "../../../v2/shared/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const id = getRouterParam(event, "id")
    if (!id) throw new ApiError("Inference API key not found", { status: 404, code: "inference_api_key_not_found" })
    await runtime.inferenceKeys.delete(id)
    return { ok: true }
  } catch (error) {
    return sendApiError(event, error)
  }
})
