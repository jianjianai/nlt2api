import { ProxyTransportError } from "~/server/utils/proxy.ts";
import type { ProxyPoolService } from "~/server/utils/proxy-pool.ts";
import type { SettingsStore } from "~/server/utils/settings.ts";
import { probeProxy, type ProxyProbeResult } from "~/server/utils/upstream.ts";
import type { ProxyRecord } from "~/server/utils/types.ts";

export interface ProxyCheckerDependencies {
  settings: SettingsStore;
  proxies: ProxyPoolService;
  probe?: (proxyUrl: string, timeoutMs: number, signal?: AbortSignal) => Promise<ProxyProbeResult>;
}

export interface ProxyCheckOutcome {
  checked: number;
  healthy: number;
}

function failureMessage(error: unknown): string {
  if (error instanceof ProxyTransportError) return error.message;
  if (error instanceof Error) return error.message;
  return "Proxy check failed.";
}

function formatBps(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} Mbps`;
  if (bps >= 1_024) return `${Math.round(bps / 1_024)} Kbps`;
  return `${bps} bps`;
}

export class ProxyChecker {
  private readonly settings: SettingsStore;
  private readonly proxies: ProxyPoolService;
  private readonly probe: (proxyUrl: string, timeoutMs: number, signal?: AbortSignal) => Promise<ProxyProbeResult>;
  private running = false;

  constructor(dependencies: ProxyCheckerDependencies) {
    this.settings = dependencies.settings;
    this.proxies = dependencies.proxies;
    this.probe = dependencies.probe ?? probeProxy;
  }

  /**
   * Probes a specific set of proxies with bounded concurrency. A proxy that
   * answers but misses the quality gate (latency or throughput) becomes
   * `rejected` with the failing measurement recorded, instead of `active`.
   */
  async checkAll(records: ProxyRecord[]): Promise<ProxyCheckOutcome> {
    const settings = this.settings.get();
    const timeoutMs = settings.proxyCheckTimeoutSeconds * 1_000;
    const queue = [...records];
    let healthy = 0;
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const record = queue.shift();
        if (!record) return;
        try {
          const result = await this.probe(record.url, timeoutMs);
          const overLatency = settings.proxyMaxLatencyMs > 0 && result.latencyMs > settings.proxyMaxLatencyMs;
          const underSpeed = settings.proxyMinThroughputBps > 0 && result.throughputBps < settings.proxyMinThroughputBps;
          if (overLatency || underSpeed) {
            const reasons: string[] = [];
            if (overLatency) reasons.push(`延迟 ${result.latencyMs}ms 超过 ${settings.proxyMaxLatencyMs}ms`);
            if (underSpeed) reasons.push(`速度 ${formatBps(result.throughputBps)} 低于 ${formatBps(settings.proxyMinThroughputBps)}`);
            this.proxies.markRejected(record.id, reasons.join("，"));
            continue;
          }
          this.proxies.markHealthy(record.id, result.latencyMs, result.throughputBps);
          healthy += 1;
        } catch (error) {
          this.proxies.markFailure(record.id, failureMessage(error));
        }
      }
    };
    const workers = Array.from({ length: Math.min(settings.proxyCheckConcurrency, Math.max(records.length, 1)) }, worker);
    await Promise.all(workers);
    return { checked: records.length, healthy };
  }

  /** One background pass over proxies whose cooldown has elapsed. */
  async tick(): Promise<ProxyCheckOutcome> {
    if (this.running) return { checked: 0, healthy: 0 };
    this.running = true;
    try {
      const settings = this.settings.get();
      const due = this.proxies.dueForCheck(settings.proxyCheckConcurrency * 4);
      if (due.length === 0) return { checked: 0, healthy: 0 };
      return await this.checkAll(due);
    } finally {
      this.running = false;
    }
  }
}
