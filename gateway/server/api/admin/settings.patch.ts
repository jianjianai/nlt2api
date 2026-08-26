import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { jsonResponse, readJsonObject } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";
import { settingBounds } from "~/server/utils/settings.ts";

export default defineHandler((event) => adminRoute(async (request) => {
  const patch = await readJsonObject(request);
  const runtime = gatewayRuntime();
  const settings = runtime.settings.patch(patch);
  if ("modelsCacheSeconds" in patch) runtime.forward.invalidateModelsCache();
  return jsonResponse({ settings, bounds: settingBounds() });
})(event.req));
