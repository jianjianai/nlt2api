import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler((event) => adminRoute(() => {
  const runtime = gatewayRuntime();
  const record = runtime.proxies.require(event.context.params?.id ?? "");
  // Tickets cascade with the proxy: a pair is meaningless without its egress.
  runtime.proxies.delete(record.id);
  return jsonResponse({ deleted: true });
})(event.req));
