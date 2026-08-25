import type {
  AccountOverview,
  GatewayConfig,
  OperationalWorkspaceId,
  ProxyPoolEntry,
  ProxyPoolSettings,
  SchedulerRuntime,
  WorkspaceId,
} from "../types/admin.ts";

export const DEFAULT_WORKSPACE: WorkspaceId = "overview";
export const DEFAULT_THEME: import("../types/admin.ts").ThemeId = "light";
export const WORKSPACE_STORAGE_KEY = "deepinfra-gateway-admin-workspace";
export const THEME_STORAGE_KEY = "deepinfra-gateway-admin-theme";

const WORKSPACES = new Set<WorkspaceId>([
  "overview",
  "accounts",
  "proxies",
  "scheduler",
  "records",
  "settings",
]);

export function parseTheme(value: unknown): import("../types/admin.ts").ThemeId {
  if (value === "gray") return "dark";
  return value === "dark" || value === "light" ? value : DEFAULT_THEME;
}

export function parseWorkspace(value: unknown): WorkspaceId {
  return typeof value === "string" && WORKSPACES.has(value as WorkspaceId)
    ? value as WorkspaceId
    : DEFAULT_WORKSPACE;
}

export interface OverviewMetric {
  id: "accounts" | "proxies" | "traffic" | "issues";
  label: string;
  value: string;
  detail: string;
  tone: "neutral" | "good" | "warn" | "bad";
}

export interface OverviewAction {
  id: string;
  title: string;
  detail: string;
  workspace: OperationalWorkspaceId | "settings";
  actionLabel: string;
  tone: "warn" | "bad";
  accountId?: string;
  proxyId?: string;
}

export interface OverviewSnapshot {
  metrics: OverviewMetric[];
  actions: OverviewAction[];
}

export function deriveOverview(
  accounts: AccountOverview,
  proxies: ProxyPoolEntry[],
  scheduler: SchedulerRuntime,
  config: GatewayConfig,
): OverviewSnapshot {
  const healthyProxies = proxies.filter((proxy) => proxy.status === "idle" || proxy.status === "in_use").length;
  const errorProxies = proxies.filter((proxy) => proxy.status === "error");

  const actions: OverviewAction[] = [];
  for (const proxy of errorProxies.slice(0, 4)) {
    actions.push({
      id: `proxy:${proxy.id}`,
      title: `${proxy.accountLabel || proxy.maskedUrl} 的代理异常`,
      detail: proxy.lastError || "最近一次代理测活或传输失败。",
      workspace: "proxies",
      actionLabel: "查看代理",
      tone: "bad",
      proxyId: proxy.id,
    });
  }
  for (const issue of accounts.issues) {
    actions.push({
      id: issue.kind === "model" ? `model:${issue.accountId}:${issue.model}` : `account:${issue.accountId}`,
      title: issue.kind === "model" ? `${issue.accountLabel} 的 ${issue.model} 正在冷却` : `${issue.accountLabel} 正在冷却`,
      detail: issue.error || (issue.kind === "model" ? `恢复时间 ${new Date(issue.until).toLocaleTimeString()}` : "账号暂时不可用于新的请求。"),
      workspace: "accounts",
      actionLabel: "查看账号",
      tone: "warn",
      accountId: issue.accountId,
    });
  }
  if (scheduler.pending > 0) {
    actions.push({
      id: "scheduler:queue",
      title: `${scheduler.pending} 个请求正在排队`,
      detail: scheduler.oldestWaitMs > 0
        ? `最老请求已等待 ${Math.ceil(scheduler.oldestWaitMs / 1_000)} 秒。`
        : "调度器正在等待可用容量。",
      workspace: "scheduler",
      actionLabel: "查看调度",
      tone: scheduler.oldestWaitMs >= 30_000 ? "bad" : "warn",
    });
  }
  if (!config.clientApiKey) {
    actions.push({
      id: "settings:api-key",
      title: "客户端 API Key 未配置",
      detail: config.clientApiKeyRequired
        ? "客户端认证已启用，但当前状态没有可用密钥。"
        : "当前客户端入口未配置 API Key。",
      workspace: "settings",
      actionLabel: "打开设置",
      tone: config.clientApiKeyRequired ? "bad" : "warn",
    });
  }

  const issueCount = errorProxies.length + accounts.cooling + accounts.modelCooling + Number(scheduler.pending > 0);
  return {
    metrics: [
      { id: "accounts", label: "启用账号", value: `${accounts.enabled}/${accounts.total}`, detail: `${accounts.sessions} 个会话有效`, tone: accounts.enabled > 0 ? "good" : "warn" },
      { id: "proxies", label: "健康代理", value: `${healthyProxies}/${proxies.length}`, detail: `${errorProxies.length} 个错误`, tone: errorProxies.length > 0 ? "warn" : "good" },
      { id: "traffic", label: "实时流量", value: `${accounts.inFlight}`, detail: `${scheduler.pending} 个排队请求`, tone: scheduler.pending > 0 ? "warn" : "neutral" },
      { id: "issues", label: "需要处理", value: `${issueCount}`, detail: issueCount > 0 ? "存在运行异常" : "运行状态正常", tone: issueCount > 0 ? "bad" : "good" },
    ],
    actions: actions.slice(0, 8),
  };
}

export function formatMicroUsd(value: number): string {
  const dollars = Math.max(0, value) / 1_000_000;
  if (dollars >= 1_000) return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (dollars >= 1) return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (dollars > 0) return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
  return "$0.00";
}

export function forecastConstraintLabel(value: import("../types/admin.ts").ForecastConstraint): string {
  return {
    account_rpm: "账号 RPM",
    model_concurrency: "模型并发",
    shared_egress_rpm: "共享出口 RPM",
    no_healthy_account: "无健康账号",
    model_cooldown: "模型冷却",
    account_cooldown: "账号冷却",
    queue_policy: "队列策略",
    insufficient_samples: "样本不足",
  }[value];
}

export function confidenceLabel(value: "high" | "medium" | "low"): string {
  return value === "high" ? "高置信度" : value === "medium" ? "中置信度" : "低置信度";
}

export function signedPercent(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.0005) return "0%";
  return `${value > 0 ? "+" : ""}${Math.round(value * 100)}%`;
}

export function proxyPolicySummary(settings: ProxyPoolSettings): string {
  const enabled: string[] = [];
  if (settings.autoAssignOnAccountCreate) enabled.push("新增账号自动匹配");
  if (settings.autoRotateOnTransportError) enabled.push("传输失败自动轮换");
  if (settings.retryCurrentRequestAfterRotation) enabled.push("轮换后重试当前请求");
  if (settings.directFallbackWhenExhausted) enabled.push("耗尽时回退直连");
  return enabled.length > 0 ? enabled.join(" · ") : "所有自动策略均已关闭";
}
