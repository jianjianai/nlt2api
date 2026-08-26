import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  // The minter service connects over /ws/minter; Nitro only bundles WebSocket
  // handlers when this feature flag is on.
  features: {
    websocket: true,
  },
  routeRules: {
    "/v1/**": {
      cors: true,
      headers: {
        "Cache-Control": "no-store",
      },
    },
    "/api/admin/**": {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  },
});
