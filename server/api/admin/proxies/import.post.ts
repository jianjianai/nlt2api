import { defineHandler } from "nitro";
import { asString, HttpError, jsonResponse, openAIErrorResponse, readJsonObject, requireAdminAuth } from "~/server/utils/http.ts";
import { proxyPoolService } from "~/server/utils/proxy-pool.ts";
import { adminHttpError } from "~/server/utils/route-helpers.ts";
import { stateStore } from "~/server/utils/state-store.ts";
import type { ProxyKind } from "~/server/utils/types.ts";

const PROTOCOLS = new Set(["http", "socks4", "socks5"]);

export default defineHandler(async (event) => {
  try {
    requireAdminAuth(event.req);
    const body = await readJsonObject(event.req);
    const text = asString(body.text, "text", { maxLength: 16 * 1024 * 1024 })!;
    const fallback = (await stateStore.getSettings()).proxyPool.defaultImportProtocol;
    const requested = body.defaultProtocol ?? fallback;
    if (typeof requested !== "string" || !PROTOCOLS.has(requested)) {
      throw new HttpError(400, "`defaultProtocol` must be http, socks4 or socks5.", "invalid_request_error", "defaultProtocol");
    }
    const results = await proxyPoolService.importText(text, requested as ProxyKind);
    return jsonResponse({ results, proxies: await proxyPoolService.snapshot() }, 201);
  } catch (error) {
    return openAIErrorResponse(adminHttpError(error));
  }
});