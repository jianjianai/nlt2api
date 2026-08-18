import { defineEventHandler } from "h3"
import packageMetadata from "../../package.json"
import { getRuntime } from "../v2/runtime"

export default defineEventHandler(async () => {
  const runtime = await getRuntime()
  await runtime.repository.assertReady()
  return { status: "ok", version: packageMetadata.version }
})
