import { definePlugin } from "nitro";
import { proxySyncService } from "~/server/utils/proxy-sync.ts";
import { stateStore } from "~/server/utils/state-store.ts";

export default definePlugin((nitro) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let lastEnabled = false;
  let lastIntervalMinutes: number | undefined;
  let nextRunAt: number | undefined;

  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      const settings = await stateStore.getProxySyncSettings();
      const now = Date.now();
      if (!settings.enabled) {
        nextRunAt = undefined;
      } else {
        const changed = !lastEnabled || lastIntervalMinutes !== settings.intervalMinutes;
        if (changed || nextRunAt === undefined) {
          // Enabling or changing the period starts a fresh full interval.
          nextRunAt = now + settings.intervalMinutes * 60_000;
        }
        if (now >= nextRunAt) {
          if (!proxySyncService.currentRun()) proxySyncService.start("scheduled");
          nextRunAt = now + settings.intervalMinutes * 60_000;
        }
      }
      lastEnabled = settings.enabled;
      lastIntervalMinutes = settings.intervalMinutes;
    } finally {
      if (!closed) {
        timer = setTimeout(() => { void tick(); }, 30_000);
        timer.unref?.();
      }
    }
  };

  void tick();
  nitro.hooks.hook("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
});
