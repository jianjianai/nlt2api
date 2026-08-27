import { definePlugin } from "nitro";
import { closeGatewayDatabase } from "~/server/utils/database.ts";
import { HttpError } from "~/server/utils/http.ts";
import { gatewayRuntime, resetGatewayRuntimeForTests } from "~/server/utils/runtime.ts";

interface Loop {
  stop(): void;
}

/**
 * Chains each tick from the end of the previous one so a slow pass cannot
 * overlap itself, and reads its period from settings every time so a change in
 * the admin console takes effect without a restart.
 */
function startLoop(intervalMs: () => number, body: () => void | Promise<void>): Loop {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, intervalMs());
    timer.unref?.();
  };
  const run = async () => {
    try {
      await body();
    } catch (error) {
      console.error("[gateway] background task failed:", error);
    } finally {
      schedule();
    }
  };
  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export default definePlugin((nitro) => {
  const runtime = gatewayRuntime();
  runtime.hub.recoverAfterRestart();

  const loops: Loop[] = [
    startLoop(
      () => runtime.settings.get().refillIntervalSeconds * 1_000,
      () => { runtime.refill.tick(); },
    ),
    startLoop(
      () => runtime.settings.get().proxyCheckIntervalSeconds * 1_000,
      async () => { await runtime.checker.tick(); },
    ),
    startLoop(
      () => runtime.settings.get().ticketCleanupIntervalSeconds * 1_000,
      () => {
        runtime.tickets.cleanup();
        runtime.hub.sweepHeartbeats();
        runtime.hub.pruneEvents();
        runtime.errors.prune();
      },
    ),
  ];

  nitro.hooks.hook("close", () => {
    for (const loop of loops) loop.stop();
    runtime.queue.rejectAll(new HttpError(503, "The gateway is shutting down.", "server_error", undefined, "shutting_down"));
    closeGatewayDatabase();
    resetGatewayRuntimeForTests();
  });
});
