import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { asString, HttpError, jsonResponse, readJsonObject } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler((event) => adminRoute(async (request) => {
  const id = event.context.params?.id ?? "";
  const body = await readJsonObject(request);
  const rawKind = body.kind === undefined ? "page" : asString(body.kind, "kind", { maxLength: 16 });
  const kind = rawKind === "fullpage" ? "fullpage" : rawKind === "page" ? "page" : null;
  if (!kind) {
    throw new HttpError(400, "`kind` must be page or fullpage.", "invalid_request_error", "kind");
  }
  const result = await gatewayRuntime().hub.requestScreenshot(id, kind);
  return jsonResponse({
    kind: result.kind,
    pngBase64: result.pngBase64,
    instances: result.instances,
  });
})(event.req));