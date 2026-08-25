import { definePlugin } from "nitro";
import { closeDeepInfraTurnstileMinter } from "~/server/utils/deepinfra-turnstile.ts";

export default definePlugin((nitro) => {
  nitro.hooks.hook("close", async () => {
    await closeDeepInfraTurnstileMinter();
  });
});
