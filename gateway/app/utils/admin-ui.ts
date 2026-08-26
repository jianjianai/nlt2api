import type { ProxyStatus, SettingKey, ThemeId, WorkspaceId } from "../types/admin.ts";

export const DEFAULT_WORKSPACE: WorkspaceId = "overview";
export const DEFAULT_THEME: ThemeId = "light";
export const TOKEN_STORAGE_KEY = "gateway-admin-token";
export const WORKSPACE_STORAGE_KEY = "gateway-admin-workspace";
export const THEME_STORAGE_KEY = "gateway-admin-theme";

const WORKSPACES = new Set<WorkspaceId>(["overview", "proxies", "tickets", "minters", "settings"]);

export function parseTheme(value: unknown): ThemeId {
  return value === "dark" || value === "light" ? value : DEFAULT_THEME;
}

export function parseWorkspace(value: unknown): WorkspaceId {
  return typeof value === "string" && WORKSPACES.has(value as WorkspaceId) ? value as WorkspaceId : DEFAULT_WORKSPACE;
}

export const PROXY_STATUS_LABEL: Record<ProxyStatus, string> = {
  active: "活跃",
  pending: "待测活",
  unavailable: "不可用",
};

export const PROXY_STATUS_TONE: Record<ProxyStatus, "good" | "warn" | "bad"> = {
  active: "good",
  pending: "warn",
  unavailable: "bad",
};

export const SETTING_LABEL: Record<SettingKey, { label: string; hint: string }> = {
  ticketTtlSeconds: { label: "凭证存活（秒）", hint: "实测上游约 3~4 分钟失效，上限 178 秒。" },
  ticketMinRemainingSeconds: { label: "取用最小剩余（秒）", hint: "低于此剩余寿命的凭证不再分配给请求。" },
  ticketCleanupIntervalSeconds: { label: "清理周期（秒）", hint: "过期凭证与滞留占用的回收间隔。" },
  minAvailableTickets: { label: "最低可用凭证", hint: "低于此数量即向在线授权服务下发补充任务。" },
  refillIntervalSeconds: { label: "补充检查周期（秒）", hint: "编排器计算缺口的频率。" },
  mintRequestTimeoutSeconds: { label: "铸票任务超时（秒）", hint: "超时后释放占用的并发计数。" },
  proxyLeaseSeconds: { label: "代理租约（秒）", hint: "授权服务独占一个代理的时长。" },
  proxyCheckIntervalSeconds: { label: "测活周期（秒）", hint: "后台批量探测待测活代理的间隔。" },
  proxyCheckTimeoutSeconds: { label: "单次测活超时（秒）", hint: "经代理拉取上游模型目录的超时。" },
  proxyCheckConcurrency: { label: "测活并发", hint: "同时进行的探测数量。" },
  proxyFailureThreshold: { label: "失败阈值", hint: "连续失败达到该次数后转为不可用。" },
  proxyRetryCooldownSeconds: { label: "失败冷却（秒）", hint: "失败后等待多久才允许重测。" },
  modelsCacheSeconds: { label: "模型列表缓存（秒）", hint: "上游模型目录的缓存时长。" },
  maxAttempts: { label: "转发重试次数", hint: "每次重试都会消耗一组新的代理与凭证。" },
  upstreamTimeoutMs: { label: "上游超时（毫秒）", hint: "上游无数据的最长等待时间。" },
};

export function formatTime(value: number | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function formatRelative(value: number | undefined, now: number): string {
  if (!value) return "—";
  const deltaSeconds = Math.round((now - value) / 1_000);
  if (deltaSeconds < 0) return `${formatDuration(-deltaSeconds)}后`;
  if (deltaSeconds < 5) return "刚刚";
  return `${formatDuration(deltaSeconds)}前`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时`;
  return `${Math.floor(seconds / 86_400)} 天`;
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "已过期";
  const seconds = Math.floor(ms / 1_000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function formatLatency(value: number | undefined): string {
  return value === undefined ? "—" : `${value} ms`;
}

/** Water-level tone for the ticket pool gauge. */
export function poolTone(available: number, minAvailable: number): "good" | "warn" | "bad" {
  if (available >= minAvailable) return "good";
  return available === 0 ? "bad" : "warn";
}
