import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler((event) => adminRoute(async () => {
  const runtime = gatewayRuntime();
  const record = runtime.proxies.require(event.context.params?.id ?? "");
  const outcome = await runtime.checker.checkAll([record]);
  const snapshot = runtime.proxies.snapshot({ limit: 1, offset: 0 });
  return jsonResponse({
    ...outcome,
    proxy: snapshot.entries.find((entry) => entry.id === record.id) ?? null,
  });
})(event.req));
