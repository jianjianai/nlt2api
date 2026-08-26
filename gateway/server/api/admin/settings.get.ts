import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";
import { settingBounds } from "~/server/utils/settings.ts";

export default defineHandler((event) => adminRoute(() => {
  return jsonResponse({ settings: gatewayRuntime().settings.get(), bounds: settingBounds() });
})(event.req));
