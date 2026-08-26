import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { asString, jsonResponse, readJsonObject } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler((event) => adminRoute(async (request) => {
  const runtime = gatewayRuntime();
  const record = runtime.proxies.require(event.context.params?.id ?? "");
  const body = await readJsonObject(request);
  if (body.label !== undefined) {
    const label = body.label === null ? undefined : asString(body.label, "label", { maxLength: 64 });
    runtime.proxies.setLabel(record.id, label);
  }
  // Re-enabling clears the failure history so the checker picks it up again.
  if (body.reactivate === true) runtime.proxies.reactivate(record.id);
  return jsonResponse({ proxy: runtime.proxies.snapshot({ limit: 500 }).entries.find((entry) => entry.id === record.id) ?? null });
})(event.req));
