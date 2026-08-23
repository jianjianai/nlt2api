import { definePlugin } from "nitro";
import { usageAnalytics } from "~/server/utils/usage-analytics.ts";

export default definePlugin((nitro) => {
  void usageAnalytics.initialize();
  const maintenance = setInterval(() => {
    void usageAnalytics.maintain();
  }, 60 * 60_000);
  maintenance.unref();
  nitro.hooks.hook("close", async () => {
    clearInterval(maintenance);
    await usageAnalytics.close();
  });
});
