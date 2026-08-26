import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { HttpError, jsonResponse } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

export default defineHandler((event) => adminRoute(() => {
  const id = event.context.params?.id ?? "";
  if (!gatewayRuntime().hub.disconnectSession(id)) {
    throw new HttpError(404, "No online authorization service with that session id.", "invalid_request_error", "id", "session_not_found");
  }
  return jsonResponse({ disconnected: true });
})(event.req));
