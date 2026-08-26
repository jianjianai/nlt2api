import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler((event) => adminRoute(() => {
  const runtime = gatewayRuntime();
  return jsonResponse({
    entries: runtime.hub.snapshot(),
    online: runtime.hub.onlineCount(),
    inflight: runtime.hub.inflightTotal(),
  });
})(event.req));
