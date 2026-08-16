import { defineNitroConfig } from "nitropack/config"

// https://nitro.build/config
export default defineNitroConfig({
  compatibilityDate: "2026-08-15",
  srcDir: "server",
  imports: false,
  publicAssets: [
    {
      dir: "../public"
    }
  ]
});
