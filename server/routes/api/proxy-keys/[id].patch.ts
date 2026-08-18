import { defineEventHandler, getRouterParam } from "h3"
import { requireAdmin } from "../../../v2/http/auth"
import { readJsonBody } from "../../../v2/http/body"
import { sendApiError } from "../../../v2/http/errors"
import { allowKeys, objectBody } from "../../../v2/http/validation"
import { ApiError } from "../../../v2/shared/errors"
import { getRuntime } from "../../../v2/runtime"

export default defineEventHandler(async (event) => {
  try {
    const runtime = await getRuntime()
    requireAdmin(event, runtime, true)
    const id = getRouterParam(event, "id")
    if (!id) throw new ApiError("Inference API key not found", { status: 404, code: "inference_api_key_not_found" })
    const body = objectBody(await readJsonBody(event))
    allowKeys(body, ["label", "enabled"])
    const key = await runtime.inferenceKeys.update(id, {
      ...(body.label !== undefined ? { label: body.label as string } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {})
    })
    return { key }
  } catch (error) {
    return sendApiError(event, error)
  }
})
