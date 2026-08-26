import { defineHandler } from "nitro";
import { adminRoute } from "~/server/utils/admin-route.ts";
import { HttpError, jsonResponse, readJsonObject } from "~/server/utils/http.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";
import type { ProxyKind } from "~/server/utils/types.ts";

const KINDS: ProxyKind[] = ["http", "socks4", "socks5"];

export default defineHandler((event) => adminRoute(async (request) => {
  const body = await readJsonObject(request);
  if (typeof body.text !== "string" || !body.text.trim()) {
    throw new HttpError(400, "`text` must be a non-empty string.", "invalid_request_error", "text");
  }
  const raw = body.defaultProtocol ?? "http";
  const defaultProtocol = KINDS.find((kind) => kind === raw);
  if (!defaultProtocol) {
    throw new HttpError(400, "`defaultProtocol` must be http, socks4 or socks5.", "invalid_request_error", "defaultProtocol");
  }
  const summary = gatewayRuntime().proxies.import(body.text, defaultProtocol);
  return jsonResponse({ ...summary });
})(event.req));
