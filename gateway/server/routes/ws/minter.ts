import { defineWebSocketHandler } from "nitro";
import { getGatewayConfig } from "~/server/utils/config.ts";
import { secureEquals } from "~/server/utils/http.ts";
import type { MinterPeer } from "~/server/utils/minter-hub.ts";
import { MAX_FRAME_BYTES, CLOSE_FRAME_TOO_LARGE } from "~/server/utils/minter-protocol.ts";
import { gatewayRuntime } from "~/server/utils/runtime.ts";

function presentedToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim() || undefined;
  return undefined;
}

export default defineWebSocketHandler({
  upgrade(request) {
    const expected = getGatewayConfig().minterToken;
    const received = presentedToken(request);
    // An unset MINTER_TOKEN closes the endpoint entirely rather than opening it:
    // the lease reply carries plaintext proxy credentials.
    if (!expected || !received || !secureEquals(received, expected)) {
      throw new Response("Unauthorized", { status: 401 });
    }
  },
  open(peer) {
    gatewayRuntime().hub.open(peer as unknown as MinterPeer);
  },
  message(peer, message) {
    const text = message.text();
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      peer.close(CLOSE_FRAME_TOO_LARGE, "frame_too_large");
      return;
    }
    gatewayRuntime().hub.message(peer as unknown as MinterPeer, text);
  },
  close(peer) {
    gatewayRuntime().hub.close(peer as unknown as MinterPeer);
  },
  error(peer) {
    gatewayRuntime().hub.close(peer as unknown as MinterPeer);
  },
});
