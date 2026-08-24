<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from "vue";
import AppConfirmDialog from "./components/ui/AppConfirmDialog.vue";
import AppDialog from "./components/ui/AppDialog.vue";
import AppIcon from "./components/ui/AppIcon.vue";
import OverviewWorkspace from "./components/OverviewWorkspace.vue";
import WorkspaceShell from "./components/WorkspaceShell.vue";
// Workspaces are lazy-loaded so the first paint only ships the shell and the
// default overview; heavier views (records, accounts) load on first visit.
const AccountsWorkspace = defineAsyncComponent(() => import("./components/AccountsWorkspace.vue"));
const GatewaySettingsWorkspace = defineAsyncComponent(() => import("./components/GatewaySettingsWorkspace.vue"));
const ProxyPoolWorkspace = defineAsyncComponent(() => import("./components/ProxyPoolWorkspace.vue"));
const RecordsWorkspace = defineAsyncComponent(() => import("./components/RecordsWorkspace.vue"));
const SchedulerWorkspace = defineAsyncComponent(() => import("./components/SchedulerWorkspace.vue"));
import { DEFAULT_THEME, deriveOverview, parseTheme, parseWorkspace, THEME_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from "./utils/admin-ui.ts";
import type {
  Account, AccountGroup, AccountGroupSummary, AccountOverview, AccountPagination, AccountSort, AccountStatusFilter, AnalyticsGranularity, AnalyticsOverview, AnalyticsQueryResult, AnalyticsRetention, AnalyticsSort, ApiPayload, BodyPresentation, CleanupPreview, ConversationTrace, DebugRawBody, DebugRecord, DebugRecordSummary,
  DebugUpstreamCall, DisplayField, DisplayMessage, DisplayToolCall, GatewayConfig, GatewaySettings, GroupApiKey,
  PreambleVerbosity, ProxyImportLineResult, ThemeId, ProxyPoolEntry, ProxyPoolSettings, ProxyPoolStatus,
  SchedulerRuntime, SchedulerSettings, SidebarItem, SidebarUpstreamItem, ToolCallFormat, WorkspaceId,
} from "./types/admin.ts";

type JsonRecord = Record<string, unknown>;

const tokenStorageKey = "neuralwatt-admin-token";
const token = ref(typeof window === "undefined" ? "" : sessionStorage.getItem(tokenStorageKey) ?? "");
const tokenDraft = ref(token.value);
const view = ref<WorkspaceId>(typeof window === "undefined" ? "overview" : parseWorkspace(localStorage.getItem(WORKSPACE_STORAGE_KEY)));
const theme = ref<ThemeId>(typeof window === "undefined" ? DEFAULT_THEME : parseTheme(localStorage.getItem(THEME_STORAGE_KEY)));
const expandedAccountId = ref<string | null>(null);
const secretResetToken = ref(0);
// shallowRef: record/account payloads are large and immutable; avoid deep reactivity.
const accountOverview = reactive<AccountOverview>({ total: 0, enabled: 0, sessions: 0, direct: 0, inFlight: 0, cooling: 0, modelCooling: 0, models: [], rows: [], issues: [] });
const accountPage = shallowRef<Account[]>([]);
const accountGroups = shallowRef<AccountGroup[]>([]);
const groupApiKeys = shallowRef<GroupApiKey[]>([]);
const groupSummary = reactive<AccountGroupSummary>({ totalAccounts: 0, ungroupedAccounts: 0 });
const accountPagination = reactive<AccountPagination>({ page: 1, pageSize: 20, total: 0, pageCount: 1 });
const proxies = shallowRef<ProxyPoolEntry[]>([]);
const records = shallowRef<DebugRecordSummary[]>([]);
const analytics = shallowRef<AnalyticsOverview | null>(null);
const analyticsResult = shallowRef<AnalyticsQueryResult | null>(null);
const analyticsRetention = reactive<AnalyticsRetention>({ executionDays: null, minuteDays: null });
const analyticsRange = ref<"today" | "month" | "custom">("today");
const analyticsGranularity = ref<AnalyticsGranularity>("minute");
const analyticsSort = ref<AnalyticsSort>("cost");
const analyticsModel = ref("");
const analyticsCustomFrom = ref("");
const analyticsCustomTo = ref("");
const isLoadingAnalytics = ref(false);
const isRefreshingPrices = ref(false);
const isSavingRetention = ref(false);
const cleanupCutoff = ref("");
const cleanupPreview = ref<CleanupPreview | null>(null);
const showCleanupConfirm = ref(false);
const isPreviewingCleanup = ref(false);
const isCleaningAnalytics = ref(false);
let analyticsRequestSequence = 0;
const defaultSchedulerSettings: SchedulerSettings = {
  accountModelConcurrency: 5,
  accountRpm: 20,
  proxyRpm: 30,
  directEgressLimitEnabled: false,
  directEgressRpm: 30,
  stickyTtlSeconds: 1_800,
  queueTimeoutSeconds: 0,
  maxQueueSize: 0,
};
const defaultProxyPoolSettings: ProxyPoolSettings = {
  autoAssignOnAccountCreate: false, autoRotateOnTransportError: false,
  retryCurrentRequestAfterRotation: true, directFallbackWhenExhausted: false,
  defaultImportProtocol: "http", healthCheckTimeoutSeconds: 10, errorRetryCooldownSeconds: 300,
};
const settings = reactive({
  recordMessages: false,
  scheduler: { ...defaultSchedulerSettings },
  proxyPool: { ...defaultProxyPoolSettings },
  minimumOutputTokens: undefined as number | undefined,
  toolCallFormat: undefined as ToolCallFormat | undefined,
  preambleVerbosity: undefined as PreambleVerbosity | undefined,
  modelToolCallFormats: {} as Record<string, ToolCallFormat>,
  modelPreambleVerbosities: {} as Record<string, PreambleVerbosity>,
});
const config = reactive({
  adminTokenConfigured: false,
  clientApiKeyRequired: false,
  clientApiKey: "",
  defaultModel: "",
  minimumOutputTokens: 8_192,
  toolCallFormat: "auto" as ToolCallFormat,
  preambleVerbosity: "milestone" as PreambleVerbosity,
});
const newAccount = reactive({ label: "", email: "", password: "", weight: 1, proxy: "", groupIds: [] as string[] });
const isLoading = ref(false);
const isConnected = ref(false);
const currentTime = ref(Date.now());
const isSaving = ref(false);
const minimumOutputTokensDraft = ref(8_192);
const isSavingMinimumOutputTokens = ref(false);
const schedulerDraft = reactive<SchedulerSettings>({ ...defaultSchedulerSettings });
const schedulerRuntime = reactive<SchedulerRuntime>({ pending: 0, oldestWaitMs: 0, egresses: [] });
const isSavingScheduler = ref(false);
const proxyPoolDraft = reactive<ProxyPoolSettings>({ ...defaultProxyPoolSettings });
const proxyImportText = ref("");
const proxyImportResults = ref<ProxyImportLineResult[]>([]);
const proxyFilter = ref<"all" | ProxyPoolStatus>("all");
const isImportingProxies = ref(false);
const isCheckingProxies = ref(false);
const isAssigningDirectProxies = ref(false);
const busyProxyIds = ref(new Set<string>());
const isSavingProxyPool = ref(false);
const isClearingRecords = ref(false);
const selectedRecordId = ref<string | null>(null);
const selectedTraceKey = ref<string | null>(null);
const rawTraceKey = ref<string | null>(null);
const loginError = ref("");
// The full record (with bodies) for the selected summary, loaded on demand.
const selectedRecord = shallowRef<DebugRecord | null>(null);
const isLoadingRecord = ref(false);

// Full record bodies can be megabytes each; keep only a small LRU cache of
// opened details so prev/next navigation stays instant without holding
// hundreds of records in memory.
const DETAIL_CACHE_MAX = 20;
const detailCache = new Map<string, DebugRecord>();

function cacheRecordDetail(record: DebugRecord): void {
  detailCache.delete(record.id);
  detailCache.set(record.id, record);
  while (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next().value;
    if (oldest === undefined) break;
    detailCache.delete(oldest);
  }
}

// ---- Toast notifications (replace the old one-line notice / error banner) ----
interface ToastItem {
  id: number;
  kind: "success" | "error";
  text: string;
}
const toasts = ref<ToastItem[]>([]);
let toastSeq = 0;
function pushToast(kind: "success" | "error", text: string): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, kind, text }];
  window.setTimeout(() => dismissToast(id), kind === "error" ? 6000 : 3500);
}
function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function copyCredential(value: string, label: string): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    pushToast("success", `已复制${label}`);
  } catch {
    pushToast("error", `无法复制${label}，请手动选择文本。`);
  }
}

// ---- Modals & per-account busy state ----
const showAddAccount = ref(false);
const proxyEditor = ref<{ account: Account; value: string } | null>(null);
const modelEditor = ref<{ account: Account; value: string } | null>(null);
const limitEditor = ref<{
  account: Account;
  accountRpm: string;
  accountModelConcurrency: string;
  modelConcurrency: Record<string, string>;
} | null>(null);
const pendingRemoval = ref<Account | null>(null);
const groupEditor = ref<{ group: AccountGroup | null; name: string; description: string; enabled: boolean } | null>(null);
const pendingGroupRemoval = ref<AccountGroup | null>(null);
const keyManagerGroup = ref<AccountGroup | null>(null);
const keyNameDraft = ref("");
const oneTimeGroupSecret = ref("");
const pendingKeyRemoval = ref<GroupApiKey | null>(null);
const isLoadingAccounts = ref(false);
const isSavingGroup = ref(false);
const isSavingGroupKey = ref(false);
const showClearConfirm = ref(false);
const dialogOpen = computed(() => Boolean(showAddAccount.value || proxyEditor.value || modelEditor.value || limitEditor.value || pendingRemoval.value || groupEditor.value || pendingGroupRemoval.value || keyManagerGroup.value || pendingKeyRemoval.value || showClearConfirm.value || showCleanupConfirm.value));
function openAddAccount(): void {
  newAccount.groupIds = accountGroupFilter.value !== "all" && accountGroupFilter.value !== "ungrouped" ? [accountGroupFilter.value] : [];
  showAddAccount.value = true;
}
const busyAccountIds = ref(new Set<string>());

function setAccountBusy(id: string, busy: boolean): void {
  const next = new Set(busyAccountIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyAccountIds.value = next;
}
function isAccountBusy(id: string): boolean {
  return busyAccountIds.value.has(id);
}

// ---- Filters ----
const accountQuery = ref("");
const accountGroupFilter = ref("all");
const accountStatusFilter = ref<AccountStatusFilter>("all");
const accountSort = ref<AccountSort>("created_desc");
const accountPageSize = ref<20 | 50 | 100>(20);
const accountPageNumber = ref(1);
const recordQuery = ref("");
const recordFilter = ref<"all" | "success" | "failed">("all");

// ---- Auto refresh ----
const autoRefresh = ref(true);
let autoRefreshTimer: number | undefined;
let clockTimer: number | undefined;
let dashboardRequestSequence = 0;
let accountRequestSequence = 0;
let accountQueryTimer: number | undefined;
let recordsRequestSequence = 0;

// Effective output budget: persisted setting > environment default.
const effectiveMinimumOutputTokens = computed(() => settings.minimumOutputTokens ?? config.minimumOutputTokens);
const allModels = computed(() => accountOverview.models);
const overviewSnapshot = computed(() => deriveOverview(accountOverview, proxies.value, schedulerRuntime, config));
const cleanupDescription = computed(() => cleanupPreview.value
  ? `将删除 ${cleanupPreview.value.executions} 条执行、${cleanupPreview.value.attempts} 次上游尝试和 ${cleanupPreview.value.minuteBuckets} 个分钟桶。日/月总账与价格版本保持不变。`
  : "请先生成清理预览。",
);

function recordFailed(record: DebugRecordSummary): boolean {
  return record.status >= 400 || Boolean(record.error);
}
const failedRecordCount = computed(() => records.value.filter(recordFailed).length);
const filteredRecords = computed(() => {
  let list = records.value;
  if (recordFilter.value === "success") list = list.filter((record) => !recordFailed(record));
  else if (recordFilter.value === "failed") list = list.filter(recordFailed);
  const query = recordQuery.value.trim().toLowerCase();
  if (query) {
    list = list.filter((record) =>
      record.endpoint.toLowerCase().includes(query)
      || (record.accountLabel ?? "").toLowerCase().includes(query));
  }
  return list;
});

function isToolIntent(record: DebugRecordSummary): boolean {
  const trace = record.toolCall;
  if (!trace) return false;
  return trace.forces
    || trace.initialOutcome === "invalid"
    || trace.finalOutcome === "tool_calls"
    || trace.finalOutcome === "invalid";
}

const toolAdapterRecords = computed(() => records.value.filter((record) =>
  isToolIntent(record)));
const toolFirstPassRate = computed(() => {
  if (toolAdapterRecords.value.length === 0) return null;
  const successes = toolAdapterRecords.value.filter((record) => record.toolCall?.initialOutcome === "tool_calls").length;
  return Math.round((successes / toolAdapterRecords.value.length) * 1_000) / 10;
});

function headers(): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-admin-token": token.value,
  };
}

async function api(path: string, init: RequestInit = {}): Promise<ApiPayload> {
  const response = await fetch(path, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as ApiPayload & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(payload.error?.message || `请求失败（${response.status}）`);
  }
  return payload;
}

async function loadAccountGroups(): Promise<void> {
  const payload = await api("/api/admin/account-groups");
  accountGroups.value = payload.groups ?? [];
  Object.assign(groupSummary, payload.groupSummary ?? { totalAccounts: 0, ungroupedAccounts: 0 });
  if (accountGroupFilter.value !== "all" && accountGroupFilter.value !== "ungrouped"
    && !accountGroups.value.some((group) => group.id === accountGroupFilter.value)) {
    accountGroupFilter.value = "all";
    accountPageNumber.value = 1;
  }
}

async function loadAccountPage(): Promise<void> {
  const sequence = ++accountRequestSequence;
  const query = new URLSearchParams({
    page: String(accountPageNumber.value),
    pageSize: String(accountPageSize.value),
    status: accountStatusFilter.value,
    sort: accountSort.value,
  });
  if (accountQuery.value.trim()) query.set("query", accountQuery.value.trim());
  if (accountGroupFilter.value !== "all") query.set("groupId", accountGroupFilter.value);
  isLoadingAccounts.value = true;
  try {
    const payload = await api(`/api/admin/accounts?${query}`);
    if (sequence !== accountRequestSequence) return;
    accountPage.value = payload.accounts ?? [];
    Object.assign(accountPagination, payload.pagination ?? { page: 1, pageSize: accountPageSize.value, total: 0, pageCount: 1 });
    accountPageNumber.value = accountPagination.page;
  } finally {
    if (sequence === accountRequestSequence) isLoadingAccounts.value = false;
  }
}

async function requestAccountPage(): Promise<void> {
  try {
    await loadAccountPage();
  } catch (error) {
    pushToast("error", errorText(error, "无法加载账号列表。"));
  }
}

async function refreshAccountWorkspace(): Promise<void> {
  await loadAccountGroups();
  await loadAccountPage();
}

function selectAccountGroup(value: string): void {
  accountGroupFilter.value = value;
  accountPageNumber.value = 1;
  expandedAccountId.value = null;
  void requestAccountPage();
}
function setAccountStatus(value: AccountStatusFilter): void {
  accountStatusFilter.value = value;
  accountPageNumber.value = 1;
  void requestAccountPage();
}
function setAccountSort(value: AccountSort): void {
  accountSort.value = value;
  accountPageNumber.value = 1;
  void requestAccountPage();
}
function setAccountPageSize(value: 20 | 50 | 100): void {
  accountPageSize.value = value;
  accountPageNumber.value = 1;
  void requestAccountPage();
}
function setAccountPage(value: number): void {
  accountPageNumber.value = value;
  expandedAccountId.value = null;
  void requestAccountPage();
}

function useToken() {
  const value = tokenDraft.value.trim();
  if (!value) {
    loginError.value = "请输入管理员令牌。";
    return;
  }
  loginError.value = "";
  token.value = value;
  sessionStorage.setItem(tokenStorageKey, value);
  void loadDashboard();
  if (view.value === "accounts") void refreshAccountWorkspace();
}

function signOut() {
  dashboardRequestSequence += 1;
  recordsRequestSequence += 1;
  isConnected.value = false;
  secretResetToken.value += 1;
  expandedAccountId.value = null;
  token.value = "";
  tokenDraft.value = "";
  sessionStorage.removeItem(tokenStorageKey);
  Object.assign(accountOverview, { total: 0, enabled: 0, sessions: 0, direct: 0, inFlight: 0, cooling: 0, modelCooling: 0, models: [], rows: [], issues: [] });
  accountPage.value = [];
  accountGroups.value = [];
  groupApiKeys.value = [];
  Object.assign(groupSummary, { totalAccounts: 0, ungroupedAccounts: 0 });
  Object.assign(accountPagination, { page: 1, pageSize: 20, total: 0, pageCount: 1 });
  proxies.value = [];
  analytics.value = null;
  analyticsResult.value = null;
  cleanupPreview.value = null;
  showCleanupConfirm.value = false;
  analyticsRequestSequence += 1;
  proxyImportResults.value = [];
  records.value = [];
  detailCache.clear();
  selectedRecordId.value = null;
  selectedRecord.value = null;
  selectedTraceKey.value = null;
  rawTraceKey.value = null;
  loginError.value = "";
  toasts.value = [];
  showAddAccount.value = false;
  proxyEditor.value = null;
  modelEditor.value = null;
  limitEditor.value = null;
  pendingRemoval.value = null;
  groupEditor.value = null;
  pendingGroupRemoval.value = null;
  keyManagerGroup.value = null;
  pendingKeyRemoval.value = null;
  oneTimeGroupSecret.value = "";
  showClearConfirm.value = false;
  autoRefresh.value = false;
}

async function loadDashboard(options?: { silent?: boolean }) {
  if (!token.value) {
    return;
  }
  const requestSequence = ++dashboardRequestSequence;
  if (!options?.silent) isLoading.value = true;
  try {
    const payload = await api("/api/admin/status");
    if (requestSequence !== dashboardRequestSequence) return;
    isConnected.value = true;
    currentTime.value = Date.now();
    Object.assign(accountOverview, payload.accountOverview ?? { total: 0, enabled: 0, sessions: 0, direct: 0, inFlight: 0, cooling: 0, modelCooling: 0, models: [], rows: [], issues: [] });
    proxies.value = payload.proxyPool ?? payload.proxies ?? [];
    applySettings(payload.settings, { syncDrafts: !options?.silent });
    Object.assign(schedulerRuntime, payload.scheduler ?? { pending: 0, oldestWaitMs: 0, egresses: [] });
    analytics.value = payload.analytics ?? null;
    Object.assign(config, payload.config ?? {});
    if (!options?.silent) minimumOutputTokensDraft.value = effectiveMinimumOutputTokens.value;
    if ((view.value === "overview" || view.value === "settings") && !analyticsResult.value) {
      void loadAnalytics();
    }
    if (view.value === "records") {
      await loadRecords();
    }
  } catch (error) {
    if (requestSequence !== dashboardRequestSequence) return;
    isConnected.value = false;
    const message = errorText(error, "无法加载控制台。");
    if (message.includes("Invalid admin token") || message.includes("管理员令牌无效")) {
      token.value = "";
      tokenDraft.value = "";
      sessionStorage.removeItem(tokenStorageKey);
      loginError.value = "管理员令牌无效或已过期，请重新输入。";
    } else if (!options?.silent) {
      pushToast("error", message);
    }
  } finally {
    if (requestSequence === dashboardRequestSequence) isLoading.value = false;
  }
}

async function loadRecords() {
  const requestSequence = ++recordsRequestSequence;
  const payload = await api("/api/admin/records?limit=100");
  if (requestSequence !== recordsRequestSequence) return;
  records.value = payload.records ?? [];
  settings.recordMessages = payload.settings?.recordMessages ?? settings.recordMessages;
  // Drop cached details for records that were pruned or cleared server-side.
  const ids = new Set(records.value.map((record) => record.id));
  for (const id of [...detailCache.keys()]) {
    if (!ids.has(id)) detailCache.delete(id);
  }
  if (selectedRecordId.value && ids.has(selectedRecordId.value)) {
    return;
  }
  selectedRecordId.value = null;
  selectedTraceKey.value = null;
  selectedRecord.value = null;
  rawTraceKey.value = null;
  const first = records.value[0];
  if (first) {
    await selectRecord(first.id);
  }
}

/** Select a record (optionally one of its upstream calls) and lazy-load its full detail. */
async function selectRecord(recordId: string, traceKey?: string): Promise<void> {
  selectedRecordId.value = recordId;
  selectedTraceKey.value = traceKey ?? `${recordId}:client`;
  rawTraceKey.value = null;
  const cached = detailCache.get(recordId);
  if (cached) {
    cacheRecordDetail(cached);
    selectedRecord.value = cached;
    isLoadingRecord.value = false;
    return;
  }
  selectedRecord.value = null;
  isLoadingRecord.value = true;
  try {
    const payload = await api(`/api/admin/records/${encodeURIComponent(recordId)}`);
    if (payload.record) {
      cacheRecordDetail(payload.record);
      if (selectedRecordId.value === recordId) {
        selectedRecord.value = payload.record;
      }
    }
  } catch (error) {
    if (selectedRecordId.value === recordId) {
      pushToast("error", errorText(error, "无法加载记录详情。"));
    }
  } finally {
    if (selectedRecordId.value === recordId) {
      isLoadingRecord.value = false;
    }
  }
}

function changeTheme(next: ThemeId): void {
  theme.value = next;
  localStorage.setItem(THEME_STORAGE_KEY, next);
}

function navigateFromOverview(next: "accounts" | "proxies" | "scheduler" | "settings", targetId?: string): void {
  void selectView(next);
  if (next === "accounts" && targetId) expandedAccountId.value = targetId;
  if (targetId) {
    void nextTick(() => document.getElementById(`${next === "accounts" ? "account" : "proxy"}-${targetId}`)?.scrollIntoView({ block: "center" }));
  }
}

function updateProxyPolicy(field: keyof ProxyPoolSettings, value: boolean | number | string): void {
  (proxyPoolDraft as unknown as Record<string, unknown>)[field] = value;
}

function updateSchedulerField(field: keyof SchedulerSettings, value: number | boolean): void {
  (schedulerDraft as unknown as Record<string, unknown>)[field] = value;
}

async function selectView(next: WorkspaceId) {
  view.value = next;
  expandedAccountId.value = null;
  secretResetToken.value += 1;
  localStorage.setItem(WORKSPACE_STORAGE_KEY, next);
  if (next === "accounts") {
    try {
      await refreshAccountWorkspace();
    } catch (error) {
      pushToast("error", errorText(error, "无法加载账号与分组。"));
    }
  }
  if ((next === "overview" || next === "settings") && !analyticsResult.value) {
    await loadAnalytics();
  }
  if (next === "records") {
    try {
      await loadRecords();
    } catch (error) {
      pushToast("error", errorText(error, "无法加载聊天记录。"));
    }
  }
}

async function addAccount() {
  if (isSaving.value) return;
  isSaving.value = true;
  try {
    await api("/api/admin/accounts", {
      method: "POST",
      body: JSON.stringify(newAccount),
    });
    newAccount.label = "";
    newAccount.email = "";
    newAccount.password = "";
    newAccount.weight = 1;
    newAccount.proxy = "";
    newAccount.groupIds = [];
    showAddAccount.value = false;
    pushToast("success", "账号验证成功并已添加");
    await Promise.all([loadDashboard({ silent: true }), refreshAccountWorkspace()]);
  } catch (error) {
    pushToast("error", errorText(error, "无法添加账号。"));
  } finally {
    isSaving.value = false;
  }
}

function openCreateGroup(): void {
  groupEditor.value = { group: null, name: "", description: "", enabled: true };
}
function openEditGroup(group: AccountGroup): void {
  groupEditor.value = { group, name: group.name, description: group.description ?? "", enabled: group.enabled };
}
async function saveAccountGroup(): Promise<void> {
  const editor = groupEditor.value;
  if (!editor || isSavingGroup.value || !editor.name.trim()) return;
  isSavingGroup.value = true;
  try {
    if (editor.group) {
      await api(`/api/admin/account-groups/${encodeURIComponent(editor.group.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editor.name, description: editor.description, enabled: editor.enabled }),
      });
      pushToast("success", `分组「${editor.name.trim()}」已更新`);
    } else {
      const payload = await api("/api/admin/account-groups", {
        method: "POST",
        body: JSON.stringify({ name: editor.name, description: editor.description }),
      });
      if (payload.group) accountGroupFilter.value = payload.group.id;
      pushToast("success", `分组「${editor.name.trim()}」已创建`);
    }
    groupEditor.value = null;
    accountPageNumber.value = 1;
    await refreshAccountWorkspace();
  } catch (error) {
    pushToast("error", errorText(error, "无法保存账号分组。"));
  } finally {
    isSavingGroup.value = false;
  }
}
function askRemoveGroup(group: AccountGroup): void {
  pendingGroupRemoval.value = group;
  groupEditor.value = null;
}
async function confirmRemoveGroup(): Promise<void> {
  const group = pendingGroupRemoval.value;
  if (!group || isSavingGroup.value) return;
  isSavingGroup.value = true;
  try {
    await api(`/api/admin/account-groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
    if (accountGroupFilter.value === group.id) accountGroupFilter.value = "all";
    accountPageNumber.value = 1;
    pendingGroupRemoval.value = null;
    await Promise.all([loadDashboard({ silent: true }), refreshAccountWorkspace()]);
    pushToast("success", `分组「${group.name}」已删除，相关 Key 已撤销`);
  } catch (error) {
    pushToast("error", errorText(error, "无法删除账号分组。"));
  } finally {
    isSavingGroup.value = false;
  }
}
async function openKeyManager(group: AccountGroup): Promise<void> {
  keyManagerGroup.value = group;
  keyNameDraft.value = "";
  oneTimeGroupSecret.value = "";
  try {
    const payload = await api(`/api/admin/account-groups/${encodeURIComponent(group.id)}/api-keys`);
    groupApiKeys.value = payload.keys ?? [];
  } catch (error) {
    keyManagerGroup.value = null;
    pushToast("error", errorText(error, "无法加载分组 API Key。"));
  }
}
function closeKeyManager(): void {
  keyManagerGroup.value = null;
  groupApiKeys.value = [];
  keyNameDraft.value = "";
  oneTimeGroupSecret.value = "";
  pendingKeyRemoval.value = null;
  secretResetToken.value += 1;
}
async function createGroupKey(): Promise<void> {
  const group = keyManagerGroup.value;
  if (!group || !keyNameDraft.value.trim() || isSavingGroupKey.value) return;
  isSavingGroupKey.value = true;
  try {
    const payload = await api(`/api/admin/account-groups/${encodeURIComponent(group.id)}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name: keyNameDraft.value }),
    });
    if (payload.key) groupApiKeys.value = [...groupApiKeys.value, payload.key];
    oneTimeGroupSecret.value = payload.secret ?? "";
    keyNameDraft.value = "";
    secretResetToken.value += 1;
    await loadAccountGroups();
    pushToast("success", "分组 API Key 已创建");
  } catch (error) {
    pushToast("error", errorText(error, "无法创建分组 API Key。"));
  } finally {
    isSavingGroupKey.value = false;
  }
}
async function rotateGroupKey(key: GroupApiKey): Promise<void> {
  const group = keyManagerGroup.value;
  if (!group || isSavingGroupKey.value) return;
  isSavingGroupKey.value = true;
  try {
    const payload = await api(`/api/admin/account-groups/${encodeURIComponent(group.id)}/api-keys/${encodeURIComponent(key.id)}/rotate`, { method: "POST" });
    if (payload.key) groupApiKeys.value = groupApiKeys.value.map((item) => item.id === key.id ? payload.key! : item);
    oneTimeGroupSecret.value = payload.secret ?? "";
    secretResetToken.value += 1;
    pushToast("success", `Key「${key.name}」已轮换`);
  } catch (error) {
    pushToast("error", errorText(error, "无法轮换分组 API Key。"));
  } finally {
    isSavingGroupKey.value = false;
  }
}
async function toggleGroupKey(key: GroupApiKey): Promise<void> {
  const group = keyManagerGroup.value;
  if (!group || isSavingGroupKey.value) return;
  isSavingGroupKey.value = true;
  try {
    const payload = await api(`/api/admin/account-groups/${encodeURIComponent(group.id)}/api-keys/${encodeURIComponent(key.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !key.enabled }),
    });
    if (payload.key) groupApiKeys.value = groupApiKeys.value.map((item) => item.id === key.id ? payload.key! : item);
    pushToast("success", key.enabled ? `Key「${key.name}」已停用` : `Key「${key.name}」已启用`);
  } catch (error) {
    pushToast("error", errorText(error, "无法更新分组 API Key。"));
  } finally {
    isSavingGroupKey.value = false;
  }
}
async function confirmRemoveGroupKey(): Promise<void> {
  const group = keyManagerGroup.value;
  const key = pendingKeyRemoval.value;
  if (!group || !key || isSavingGroupKey.value) return;
  isSavingGroupKey.value = true;
  try {
    await api(`/api/admin/account-groups/${encodeURIComponent(group.id)}/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
    groupApiKeys.value = groupApiKeys.value.filter((item) => item.id !== key.id);
    pendingKeyRemoval.value = null;
    await loadAccountGroups();
    pushToast("success", `Key「${key.name}」已撤销`);
  } catch (error) {
    pushToast("error", errorText(error, "无法撤销分组 API Key。"));
  } finally {
    isSavingGroupKey.value = false;
  }
}
async function saveAccountMembership(account: Account, groupIds: string[]): Promise<void> {
  if (isAccountBusy(account.id)) return;
  setAccountBusy(account.id, true);
  try {
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ groupIds }),
    });
    if (payload.account) replaceAccount(payload.account);
    await Promise.all([loadDashboard({ silent: true }), refreshAccountWorkspace()]);
    pushToast("success", `${account.label} 的分组已更新`);
  } catch (error) {
    pushToast("error", errorText(error, "无法更新账号分组。"));
  } finally {
    setAccountBusy(account.id, false);
  }
}

async function verifyAccount(account: Account) {
  if (isAccountBusy(account.id)) return;
  setAccountBusy(account.id, true);
  try {
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(account.id)}/verify`, { method: "POST" });
    if (payload.account) {
      replaceAccount(payload.account);
    }
    pushToast("success", `${account.label} 验证成功`);
  } catch (error) {
    pushToast("error", errorText(error, "账号验证失败。"));
  } finally {
    setAccountBusy(account.id, false);
  }
}

function openProxyEditor(account: Account) {
  proxyEditor.value = { account, value: "" };
}

function openModelEditor(account: Account) {
  modelEditor.value = { account, value: account.models.join("\n") };
}

function openLimitEditor(account: Account) {
  limitEditor.value = {
    account,
    accountRpm: account.schedulerOverrides?.accountRpm?.toString() ?? "",
    accountModelConcurrency: account.schedulerOverrides?.accountModelConcurrency?.toString() ?? "",
    modelConcurrency: Object.fromEntries(account.models.map((model) => [model, account.schedulerOverrides?.modelConcurrency?.[model]?.toString() ?? ""])),
  };
}

function optionalPositiveInteger(value: string, label: string, maximum: number): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label}必须是 1 到 ${maximum} 的整数。`);
  }
  return parsed;
}

async function saveAccountLimits() {
  const editor = limitEditor.value;
  if (!editor || isAccountBusy(editor.account.id)) return;
  try {
    const accountRpm = optionalPositiveInteger(editor.accountRpm, "账号 RPM", 100_000);
    const accountModelConcurrency = optionalPositiveInteger(editor.accountModelConcurrency, "账号模型并发", 1_000);
    const modelConcurrency: Record<string, number> = {};
    for (const model of editor.account.models) {
      const value = optionalPositiveInteger(editor.modelConcurrency[model] ?? "", `模型 ${model} 并发`, 1_000);
      if (value !== undefined) modelConcurrency[model] = value;
    }
    const schedulerOverrides = {
      ...(accountRpm !== undefined ? { accountRpm } : {}),
      ...(accountModelConcurrency !== undefined ? { accountModelConcurrency } : {}),
      ...(Object.keys(modelConcurrency).length > 0 ? { modelConcurrency } : {}),
    };
    setAccountBusy(editor.account.id, true);
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(editor.account.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ schedulerOverrides: Object.keys(schedulerOverrides).length > 0 ? schedulerOverrides : null }),
    });
    if (payload.account) replaceAccount(payload.account);
    limitEditor.value = null;
    pushToast("success", `${editor.account.label} 的调度限额已更新`);
  } catch (error) {
    pushToast("error", errorText(error, "无法更新账号调度限额。"));
  } finally {
    setAccountBusy(editor.account.id, false);
  }
}

async function fetchAccountModels(account: Account) {
  if (isAccountBusy(account.id)) return;
  const before = account.models.length;
  setAccountBusy(account.id, true);
  try {
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(account.id)}/models`, { method: "POST" });
    if (payload.account) {
      replaceAccount(payload.account);
    }
    const after = payload.account?.models.length ?? before;
    pushToast("success", `${account.label} 已自动获取模型列表（新增 ${Math.max(0, after - before)} 个）`);
  } catch (error) {
    pushToast("error", errorText(error, "无法获取模型列表。"));
  } finally {
    setAccountBusy(account.id, false);
  }
}

async function saveModels() {
  const editor = modelEditor.value;
  if (!editor || isAccountBusy(editor.account.id)) return;
  const models = editor.value
    .split(/[\n,，;；]+/)
    .map((model) => model.trim())
    .filter(Boolean);
  setAccountBusy(editor.account.id, true);
  try {
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(editor.account.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ models }),
    });
    if (payload.account) {
      replaceAccount(payload.account);
    }
    pushToast("success", `${editor.account.label} 的模型列表已更新`);
    modelEditor.value = null;
  } catch (error) {
    pushToast("error", errorText(error, "无法更新模型列表。"));
  } finally {
    setAccountBusy(editor.account.id, false);
  }
}

async function saveProxy() {
  const editor = proxyEditor.value;
  if (!editor || isAccountBusy(editor.account.id)) return;
  const value = editor.value.trim();
  setAccountBusy(editor.account.id, true);
  try {
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(editor.account.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ proxy: value === "" ? null : value }),
    });
    if (payload.account) {
      replaceAccount(payload.account);
    }
    pushToast("success", value === "" ? `${editor.account.label} 的代理已清除` : `${editor.account.label} 的代理已更新；登录态仅在门户拒绝后刷新`);
    proxyEditor.value = null;
  } catch (error) {
    pushToast("error", errorText(error, "无法更新代理。"));
  } finally {
    setAccountBusy(editor.account.id, false);
  }
}

async function toggleAccount(account: Account) {
  if (isAccountBusy(account.id)) return;
  setAccountBusy(account.id, true);
  try {
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !account.enabled }),
    });
    if (payload.account) {
      replaceAccount(payload.account);
    }
    pushToast("success", account.enabled ? `${account.label} 已禁用` : `${account.label} 已启用`);
  } catch (error) {
    pushToast("error", errorText(error, "无法更新账号。"));
  } finally {
    setAccountBusy(account.id, false);
  }
}

function askRemoveAccount(account: Account) {
  pendingRemoval.value = account;
}

async function confirmRemoveAccount() {
  const account = pendingRemoval.value;
  if (!account || isAccountBusy(account.id)) return;
  setAccountBusy(account.id, true);
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    accountPage.value = accountPage.value.filter((item) => item.id !== account.id);
    pendingRemoval.value = null;
    await Promise.all([loadDashboard({ silent: true }), refreshAccountWorkspace()]);
    pushToast("success", `账号「${account.label}」已移除`);
  } catch (error) {
    pushToast("error", errorText(error, "无法移除账号。"));
  } finally {
    setAccountBusy(account.id, false);
  }
}

async function setRecording(value: boolean) {
  try {
    const payload = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ recordMessages: value }),
    });
    recordsRequestSequence += 1;
    dashboardRequestSequence += 1;
    settings.recordMessages = payload.settings?.recordMessages ?? value;
    pushToast("success", value ? "已开启消息记录" : "已关闭消息记录");
  } catch (error) {
    pushToast("error", errorText(error, "无法更新消息记录设置。"));
  }
}

async function patchToolCallSettings(body: JsonRecord, successText: string) {
  try {
    const payload = await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify(body) });
    commitSettings(payload.settings);
    pushToast("success", successText);
  } catch (error) {
    pushToast("error", errorText(error, "无法更新工具调用设置。"));
  }
}

function setProxyBusy(id: string, busy: boolean): void {
  const next = new Set(busyProxyIds.value); if (busy) next.add(id); else next.delete(id); busyProxyIds.value = next;
}

async function importProxies() {
  if (!proxyImportText.value.trim() || isImportingProxies.value) return;
  isImportingProxies.value = true;
  try {
    const payload = await api("/api/admin/proxies/import", { method: "POST", body: JSON.stringify({ text: proxyImportText.value, defaultProtocol: proxyPoolDraft.defaultImportProtocol }) });
    proxies.value = payload.proxies ?? proxies.value; proxyImportResults.value = payload.results ?? [];
    const created = proxyImportResults.value.filter((item) => item.status === "created").length;
    const invalid = proxyImportResults.value.filter((item) => item.status === "invalid").length;
    pushToast(invalid ? "error" : "success", `代理导入完成：新增 ${created}，错误 ${invalid}`);
  } catch (error) { pushToast("error", errorText(error, "无法导入代理。")); } finally { isImportingProxies.value = false; }
}

async function checkProxyEntry(proxy: ProxyPoolEntry) {
  if (busyProxyIds.value.has(proxy.id)) return; setProxyBusy(proxy.id, true);
  try { const payload = await api(`/api/admin/proxies/${encodeURIComponent(proxy.id)}/check`, { method: "POST" }); proxies.value = payload.proxies ?? proxies.value; pushToast("success", `${proxy.maskedUrl} 测活成功`); }
  catch (error) { pushToast("error", errorText(error, "代理测活失败。")); await loadDashboard({ silent: true }); }
  finally { setProxyBusy(proxy.id, false); }
}

async function checkProxyPool(scope: "error" | "all") {
  if (isCheckingProxies.value) return; isCheckingProxies.value = true;
  try { const payload = await api("/api/admin/proxies/check", { method: "POST", body: JSON.stringify({ scope }) }); proxies.value = payload.proxies ?? proxies.value; pushToast("success", "批量测活完成"); }
  catch (error) { pushToast("error", errorText(error, "无法批量测活。")); } finally { isCheckingProxies.value = false; }
}

async function deleteProxyEntry(proxy: ProxyPoolEntry) {
  if (busyProxyIds.value.has(proxy.id)) return; setProxyBusy(proxy.id, true);
  try { await api(`/api/admin/proxies/${encodeURIComponent(proxy.id)}`, { method: "DELETE" }); proxies.value = proxies.value.filter((entry) => entry.id !== proxy.id); pushToast("success", `${proxy.maskedUrl} 已删除`); }
  catch (error) { pushToast("error", errorText(error, "无法删除代理。")); } finally { setProxyBusy(proxy.id, false); }
}

async function saveProxyPoolSettings() {
  isSavingProxyPool.value = true;
  try { const payload = await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ proxyPool: proxyPoolDraft }) }); commitSettings(payload.settings); pushToast("success", "代理池策略已生效"); }
  catch (error) { pushToast("error", errorText(error, "无法更新代理池策略。")); } finally { isSavingProxyPool.value = false; }
}

async function assignProxy(account: Account) {
  if (account.proxy || isAccountBusy(account.id)) return; setAccountBusy(account.id, true);
  try { const payload = await api(`/api/admin/accounts/${encodeURIComponent(account.id)}/assign-proxy`, { method: "POST" }); if (payload.account) replaceAccount(payload.account); await loadDashboard({ silent: true }); pushToast("success", `${account.label} 已分配空闲代理`); }
  catch (error) { pushToast("error", errorText(error, "无法分配空闲代理。")); } finally { setAccountBusy(account.id, false); }
}

async function assignProxiesToDirectAccounts() {
  if (isAssigningDirectProxies.value) return;
  isAssigningDirectProxies.value = true;
  try {
    const payload = await api("/api/admin/proxies/assign-direct", { method: "POST" });
    await Promise.all([loadDashboard({ silent: true }), view.value === "accounts" ? refreshAccountWorkspace() : Promise.resolve()]);
    const assigned = payload.assigned ?? 0;
    const failed = payload.failed ?? 0;
    const remaining = payload.remaining ?? 0;
    pushToast(failed > 0 ? "error" : "success", `已分配 ${assigned} 个账号，剩余直连 ${remaining}${failed ? `，失败 ${failed}` : ""}`);
  } catch (error) {
    pushToast("error", errorText(error, "无法批量分配代理。"));
  } finally {
    isAssigningDirectProxies.value = false;
  }
}

async function saveSchedulerSettings() {
  for (const [field, value] of Object.entries(schedulerDraft)) {
    const allowsZero = field === "queueTimeoutSeconds" || field === "maxQueueSize";
    if (typeof value !== "boolean" && (!Number.isInteger(value) || value < (allowsZero ? 0 : 1))) {
      pushToast("error", "调度设置必须使用有效整数；排队超时和队列上限可设为 0。");
      return;
    }
  }
  isSavingScheduler.value = true;
  try {
    const payload = await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ scheduler: schedulerDraft }) });
    commitSettings(payload.settings);
    pushToast("success", "调度与队列设置已生效");
  } catch (error) {
    pushToast("error", errorText(error, "无法更新调度设置。"));
  } finally {
    isSavingScheduler.value = false;
  }
}

async function saveMinimumOutputTokens() {
  const value = Number(minimumOutputTokensDraft.value);
  if (!Number.isInteger(value) || value < 0 || value > 8_192) {
    pushToast("error", "最小上游输出预算必须是 0 到 8192 的整数。");
    return;
  }
  isSavingMinimumOutputTokens.value = true;
  try {
    const payload = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ minimumOutputTokens: value }),
    });
    commitSettings(payload.settings);
    minimumOutputTokensDraft.value = effectiveMinimumOutputTokens.value;
    pushToast("success", value === 0 ? "已关闭最小上游输出预算" : `最小上游输出预算已设为 ${value}`);
  } catch (error) {
    pushToast("error", errorText(error, "无法更新最小上游输出预算。"));
  } finally {
    isSavingMinimumOutputTokens.value = false;
  }
}

function setToolCallFormat(value: ToolCallFormat) {
  void patchToolCallSettings({ toolCallFormat: value }, `全局信封格式已设为 ${value}`);
}

function setPreambleVerbosity(value: PreambleVerbosity) {
  const labels: Record<PreambleVerbosity, string> = { quiet: "静默", normal: "关键步骤播报", verbose: "逐步播报", milestone: "里程碑播报" };
  void patchToolCallSettings({ preambleVerbosity: value }, `进度播报已设为 ${labels[value]}`);
}

function setModelToolCallFormat(model: string, value: string) {
  const next: Record<string, ToolCallFormat> = { ...(settings.modelToolCallFormats ?? {}) };
  if (value === "auto" || value === "json" || value === "xml") {
    next[model] = value;
  } else {
    delete next[model];
  }
  void patchToolCallSettings({ modelToolCallFormats: next }, value ? `模型 ${model} 已固定为 ${value}` : `模型 ${model} 已恢复跟随全局`);
}

function onToolCallFormatChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "auto" || value === "json" || value === "xml") {
    setToolCallFormat(value);
  }
}

function onPreambleVerbosityChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "quiet" || value === "normal" || value === "verbose" || value === "milestone") {
    setPreambleVerbosity(value);
  }
}

function onModelToolCallFormatChange(model: string, event: Event) {
  setModelToolCallFormat(model, (event.target as HTMLSelectElement).value);
}

function setModelPreambleVerbosity(model: string, value: string) {
  const next: Record<string, PreambleVerbosity> = { ...(settings.modelPreambleVerbosities ?? {}) };
  if (value === "quiet" || value === "normal" || value === "verbose" || value === "milestone") {
    next[model] = value;
  } else {
    delete next[model];
  }
  void patchToolCallSettings({ modelPreambleVerbosities: next }, value ? `模型 ${model} 播报已设为 ${value}` : `模型 ${model} 播报已恢复跟随全局`);
}

function onModelPreambleVerbosityChange(model: string, event: Event) {
  setModelPreambleVerbosity(model, (event.target as HTMLSelectElement).value);
}

async function loadAnalytics(): Promise<void> {
  const sequence = ++analyticsRequestSequence;
  const now = new Date();
  let from: Date;
  let to = now;
  if (analyticsRange.value === "month") {
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else if (analyticsRange.value === "custom") {
    from = new Date(`${analyticsCustomFrom.value}T00:00:00.000Z`);
    to = new Date(`${analyticsCustomTo.value}T00:00:00.000Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      pushToast("error", "请选择有效的分析时间范围。");
      return;
    }
  } else {
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  isLoadingAnalytics.value = true;
  try {
    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      granularity: analyticsGranularity.value,
      sort: analyticsSort.value,
      direction: "desc",
    });
    if (analyticsModel.value) query.set("model", analyticsModel.value);
    const payload = await api(`/api/admin/analytics?${query}`);
    if (sequence !== analyticsRequestSequence) return;
    analyticsResult.value = payload.result ?? null;
    Object.assign(analyticsRetention, payload.retention ?? { executionDays: null, minuteDays: null });
  } catch (error) {
    if (sequence === analyticsRequestSequence) pushToast("error", errorText(error, "无法加载分析明细。"));
  } finally {
    if (sequence === analyticsRequestSequence) isLoadingAnalytics.value = false;
  }
}

function setAnalyticsRange(value: "today" | "month" | "custom"): void {
  analyticsRange.value = value;
  if (value === "today") analyticsGranularity.value = "minute";
  if (value === "month") analyticsGranularity.value = "day";
  if (value !== "custom") void loadAnalytics();
}

function setAnalyticsGranularity(value: AnalyticsGranularity): void {
  analyticsGranularity.value = value;
  void loadAnalytics();
}

function setAnalyticsSort(value: AnalyticsSort): void {
  analyticsSort.value = value;
  void loadAnalytics();
}

function setAnalyticsModel(value: string): void {
  analyticsModel.value = value;
  void loadAnalytics();
}

async function refreshAnalyticsPrices(): Promise<void> {
  if (isRefreshingPrices.value) return;
  isRefreshingPrices.value = true;
  try {
    await api("/api/admin/analytics/prices/refresh", { method: "POST" });
    await loadDashboard({ silent: true });
    pushToast("success", "模型价格目录已刷新");
  } catch (error) {
    pushToast("error", errorText(error, "无法刷新模型价格目录。"));
  } finally {
    isRefreshingPrices.value = false;
  }
}

async function saveAnalyticsRetention(value: AnalyticsRetention): Promise<void> {
  if (isSavingRetention.value) return;
  isSavingRetention.value = true;
  try {
    const payload = await api("/api/admin/analytics/retention", { method: "PATCH", body: JSON.stringify(value) });
    Object.assign(analyticsRetention, payload.retention ?? value);
    pushToast("success", "分析数据保留策略已保存");
  } catch (error) {
    pushToast("error", errorText(error, "无法保存分析数据保留策略。"));
  } finally {
    isSavingRetention.value = false;
  }
}

async function previewAnalyticsCleanup(): Promise<void> {
  if (isPreviewingCleanup.value || !cleanupCutoff.value) return;
  isPreviewingCleanup.value = true;
  try {
    const payload = await api("/api/admin/analytics/cleanup/preview", {
      method: "POST",
      body: JSON.stringify({ cutoff: new Date(cleanupCutoff.value).toISOString() }),
    });
    cleanupPreview.value = payload.preview ?? null;
    showCleanupConfirm.value = Boolean(cleanupPreview.value);
  } catch (error) {
    pushToast("error", errorText(error, "无法生成分析数据清理预览。"));
  } finally {
    isPreviewingCleanup.value = false;
  }
}

async function confirmAnalyticsCleanup(): Promise<void> {
  if (!cleanupPreview.value || isCleaningAnalytics.value) return;
  isCleaningAnalytics.value = true;
  try {
    const payload = await api("/api/admin/analytics/cleanup", {
      method: "POST",
      body: JSON.stringify({ token: cleanupPreview.value.token }),
    });
    const deleted = payload.deleted;
    showCleanupConfirm.value = false;
    cleanupPreview.value = null;
    await Promise.all([loadDashboard({ silent: true }), loadAnalytics()]);
    pushToast("success", `已清理 ${deleted?.executions ?? 0} 条执行明细，历史总账保持不变`);
  } catch (error) {
    pushToast("error", errorText(error, "无法清理分析数据。"));
  } finally {
    isCleaningAnalytics.value = false;
  }
}

// Replace (not merge) the optional fields: cleared keys are absent from the
// server payload, and Object.assign would keep the stale local value.
function commitSettings(next: ApiPayload["settings"]): void {
  dashboardRequestSequence += 1;
  isLoading.value = false;
  applySettings(next);
}

function applySettings(next: ApiPayload["settings"], options: { syncDrafts?: boolean } = {}) {
  settings.recordMessages = next?.recordMessages ?? false;
  settings.scheduler = { ...defaultSchedulerSettings, ...(next?.scheduler ?? {}) };
  settings.proxyPool = { ...defaultProxyPoolSettings, ...(next?.proxyPool ?? {}) };
  if (options.syncDrafts !== false) {
    Object.assign(schedulerDraft, settings.scheduler);
    Object.assign(proxyPoolDraft, settings.proxyPool);
  }
  settings.minimumOutputTokens = next?.minimumOutputTokens;
  settings.toolCallFormat = next?.toolCallFormat;
  settings.preambleVerbosity = next?.preambleVerbosity;
  settings.modelToolCallFormats = next?.modelToolCallFormats ?? {};
  settings.modelPreambleVerbosities = next?.modelPreambleVerbosities ?? {};
}

function askClearRecords() {
  if (records.value.length === 0 || isClearingRecords.value) return;
  showClearConfirm.value = true;
}

async function confirmClearRecords() {
  if (isClearingRecords.value) return;
  isClearingRecords.value = true;
  try {
    await api("/api/admin/records", { method: "DELETE" });
    detailCache.clear();
    selectedRecordId.value = null;
    selectedRecord.value = null;
    rawTraceKey.value = null;
    selectedTraceKey.value = null;
    records.value = [];
    showClearConfirm.value = false;
    pushToast("success", "已清空全部聊天记录");
  } catch (error) {
    pushToast("error", errorText(error, "无法清空聊天记录。"));
  } finally {
    isClearingRecords.value = false;
  }
}

function replaceAccount(next: Account) {
  const index = accountPage.value.findIndex((account) => account.id === next.id);
  accountPage.value = index === -1
    ? [...accountPage.value, next]
    : accountPage.value.map((account, position) => (position === index ? next : account));
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function displayValue(value: unknown): string {
  return typeof value === "string" ? value : pretty(value);
}

function roleName(role: unknown, type?: unknown): string {
  const names: Record<string, string> = {
    system: "系统",
    developer: "开发者",
    user: "用户",
    assistant: "助手",
    tool: "工具",
    function: "函数",
  };
  const key = typeof role === "string" ? role : typeof type === "string" ? type : "message";
  return names[key] ?? key;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      const item = asObject(part);
      if (!item) return displayValue(part);
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      if (typeof item.image_url === "string") return `[图片] ${item.image_url}`;
      const image = asObject(item.image_url);
      if (image && typeof image.url === "string") return `[图片] ${image.url}`;
      return displayValue(item);
    }).filter(Boolean).join("\n");
  }
  if (value === null || value === undefined) {
    return "";
  }
  return displayValue(value);
}

function toolCalls(value: unknown): DisplayToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const call = asObject(raw) ?? {};
    const fn = asObject(call.function) ?? {};
    return {
      id: typeof call.id === "string" ? call.id : `tool_${index + 1}`,
      name: typeof fn.name === "string" ? fn.name : typeof call.name === "string" ? call.name : "未命名工具",
      arguments: contentText(fn.arguments ?? call.arguments ?? {}),
    };
  });
}

function displayMessage(value: unknown): DisplayMessage | null {
  const message = asObject(value);
  if (!message) return null;
  const role = typeof message.role === "string" ? message.role : "assistant";
  const output = message.content
    ?? message.text
    ?? message.reasoning
    ?? message.reasoning_content
    ?? message.refusal
    ?? message.arguments;
  const calls = toolCalls(message.tool_calls);
  return {
    role,
    roleLabel: roleName(role),
    content: contentText(output),
    toolCalls: calls,
  };
}

/** Extract thinking/reasoning text from a single message object. */
function messageReasoningText(message: JsonRecord): string {
  const reasoning = message.reasoning;
  if (typeof reasoning === "string") return reasoning;
  const reasoningContent = message.reasoning_content;
  if (typeof reasoningContent === "string") return reasoningContent;
  return "";
}

/**
 * Render one message, splitting assistant reasoning into its own 思考 box so
 * thinking and the final reply are always separate boxes.
 */
function splitMessage(value: unknown): DisplayMessage[] {
  const rendered = displayMessage(value);
  if (!rendered) return [];
  const message = asObject(value);
  if (!message || rendered.role !== "assistant") return [rendered];
  const reasoning = messageReasoningText(message);
  const body = contentText(message.content ?? message.text ?? message.refusal ?? message.arguments);
  const calls = rendered.toolCalls;
  if (reasoning && body) {
    return [
      { ...rendered, roleLabel: "思考", content: reasoning, toolCalls: [] },
      { ...rendered, roleLabel: "最终回复", content: body, toolCalls: calls },
    ];
  }
  if (reasoning) {
    return [
      { ...rendered, roleLabel: "思考", content: reasoning, toolCalls: [] },
      ...(calls.length ? [{ ...rendered, roleLabel: "工具调用", content: "", toolCalls: calls }] : []),
    ];
  }
  return [rendered];
}

/** True when a parsed SSE datum belongs to a chat stream. */
function isStreamingChunk(value: unknown): boolean {
  const source = asObject(value);
  if (!source) return false;
  if (source.object === "chat.completion.chunk") return true;
  const choice = asObject(Array.isArray(source.choices) ? source.choices[0] : undefined);
  return choice?.delta !== undefined;
}

/** Strip internal adapter markers so debug output shows clean content. */
function cleanMarkers(value: string): string {
  return value.split("<|REPAIR_REASONING|>").join(" ").split("<|FINAL_REPLY|>").join("").replace(/\s+/g, " ").trim();
}

function buildAggregatedMessages(options: {
  reasoning: string;
  content: string;
  toolCalls: DisplayToolCall[];
  errors?: string[];
}): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const reasoning = options.reasoning.trim();
  if (reasoning) {
    messages.push({ role: "assistant", roleLabel: "思考", content: reasoning, toolCalls: [] });
  }
  const content = options.content.trim();
  if (content) {
    messages.push({ role: "assistant", roleLabel: "最终回复", content, toolCalls: options.toolCalls });
  } else if (options.toolCalls.length > 0) {
    messages.push({ role: "assistant", roleLabel: "工具调用", content: "", toolCalls: options.toolCalls });
  }
  for (const error of options.errors ?? []) {
    messages.push({ role: "error", roleLabel: "错误", content: error, toolCalls: [] });
  }
  return messages;
}

/** Merge chat.completion.chunk deltas into 思考 / 最终回复 / 工具调用 boxes. */
function aggregateChatCompletionChunks(chunks: unknown[], stripMarkers = true): DisplayMessage[] {
  let content = "";
  let reasoning = "";
  let reasoningContent = "";
  let refusal = "";
  const toolCalls = new Map<number, DisplayToolCall>();
  for (const raw of chunks) {
    const source = asObject(raw);
    const choice = asObject(Array.isArray(source?.choices) ? source.choices[0] : undefined);
    const delta = asObject(choice?.delta);
    if (!delta) continue;
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
    if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
    if (typeof delta.refusal === "string") refusal += delta.refusal;
    if (Array.isArray(delta.tool_calls)) {
      for (const partialValue of delta.tool_calls) {
        const partial = asObject(partialValue) ?? {};
        const index = typeof partial.index === "number" ? partial.index : toolCalls.size;
        const fn = asObject(partial.function) ?? {};
        const known = toolCalls.get(index);
        if (!known) {
          toolCalls.set(index, {
            id: typeof partial.id === "string" ? partial.id : `tool_${index + 1}`,
            name: typeof fn.name === "string" ? fn.name : "未命名工具",
            arguments: typeof fn.arguments === "string" ? fn.arguments : "",
          });
        } else {
          if (typeof partial.id === "string") known.id = partial.id;
          if (typeof fn.name === "string") known.name = fn.name;
          if (typeof fn.arguments === "string") known.arguments += fn.arguments;
        }
      }
    }
  }
  return buildAggregatedMessages({
    reasoning: stripMarkers ? cleanMarkers(reasoning || reasoningContent) : (reasoning || reasoningContent).trim(),
    content: stripMarkers ? cleanMarkers(content || refusal) : (content || refusal).trim(),
    toolCalls: [...toolCalls.values()],
  });
}

function aggregateStreamingMessages(values: unknown[], stripMarkers: boolean): DisplayMessage[] {
  const chunks = values.filter(isStreamingChunk);
  if (chunks.length === 0) return [];
  return aggregateChatCompletionChunks(chunks, stripMarkers);
}

/** Parse a Responses API stream event (`response.*`), else null. */
function asResponseEvent(value: unknown): JsonRecord | null {
  const source = asObject(value);
  return source && typeof source.type === "string" && source.type.startsWith("response.") ? source : null;
}

/** True when a parsed SSE datum is a Responses API event. */
function isResponseStreamEvent(value: unknown): boolean {
  return asResponseEvent(value) !== null;
}

/** Text carried by one Responses content part (input_text/output_text/refusal/image). */
function responsePartText(part: unknown): string {
  const item = asObject(part);
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.refusal === "string") return item.refusal;
  if (typeof item.image_url === "string") return `[图片] ${item.image_url}`;
  return "";
}

/** Render one Responses input/output item (message, reasoning, function call, tool output). */
function responseItemMessages(item: unknown, stripMarkers: boolean): DisplayMessage[] {
  const source = asObject(item);
  if (!source) return [];
  const type = typeof source.type === "string" ? source.type : typeof source.role === "string" ? "message" : "";
  if (type === "message") {
    const role = typeof source.role === "string" ? source.role : "assistant";
    const content = typeof source.content === "string"
      ? source.content
      : Array.isArray(source.content)
        ? source.content.map(responsePartText).filter(Boolean).join("\n")
        : "";
    if (!content) return [];
    return [{
      role,
      roleLabel: roleName(role),
      content: stripMarkers && role === "assistant" ? cleanMarkers(content) : content,
      toolCalls: [],
    }];
  }
  if (type === "reasoning") {
    const summary = Array.isArray(source.summary) ? source.summary : [];
    const text = summary
      .map((part) => asObject(part)?.text)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const cleaned = stripMarkers ? cleanMarkers(text) : text.trim();
    return cleaned ? [{ role: "assistant", roleLabel: "思考", content: cleaned, toolCalls: [] }] : [];
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const payload = type === "custom_tool_call" ? source.input : source.arguments;
    return [{
      role: "assistant",
      roleLabel: "工具调用",
      content: "",
      toolCalls: [{
        id: typeof source.call_id === "string" ? source.call_id : typeof source.id === "string" ? source.id : "tool_call",
        name: typeof source.name === "string" ? source.name : "未命名工具",
        arguments: contentText(payload ?? ""),
      }],
    }];
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const output = source.output;
    const record = asObject(output);
    const text = typeof output === "string"
      ? output
      : typeof record?.content === "string"
        ? record.content
        : Array.isArray(record?.content)
          ? record.content.map(responsePartText).filter(Boolean).join("\n")
          : pretty(output ?? "");
    return [{ role: "tool", roleLabel: roleName("tool"), content: text, toolCalls: [] }];
  }
  return [];
}

/** Render the `output` array of a Responses object. */
function responseOutputMessages(output: unknown[], stripMarkers: boolean): DisplayMessage[] {
  return output.flatMap((item) => responseItemMessages(item, stripMarkers));
}

/** Render a non-streaming Responses request or response body. */
function collectResponseMessages(source: JsonRecord): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  if (typeof source.instructions === "string" && source.instructions.trim()) {
    messages.push({ role: "system", roleLabel: roleName("system"), content: source.instructions, toolCalls: [] });
  }
  if (typeof source.input === "string") {
    if (source.input.trim()) {
      messages.push({ role: "user", roleLabel: roleName("user"), content: source.input, toolCalls: [] });
    }
  } else if (Array.isArray(source.input)) {
    messages.push(...source.input.flatMap((item) => responseItemMessages(item, true)));
  }
  if (Array.isArray(source.output)) {
    messages.push(...responseOutputMessages(source.output, true));
  }
  const error = asObject(source.error);
  if (error && typeof error.message === "string") {
    messages.push({ role: "error", roleLabel: "错误", content: error.message, toolCalls: [] });
  }
  return messages;
}

/** The terminal response object of a Responses stream (completed / failed / incomplete). */
function responseStreamTerminal(values: unknown[]): JsonRecord | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const event = asResponseEvent(values[index]);
    if (event && (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete")) {
      return asObject(event.response) ?? null;
    }
  }
  return null;
}

/** Merge Responses API stream events into 思考 / 助手 / 工具调用 boxes. */
function aggregateResponseStreamEvents(values: unknown[], stripMarkers: boolean): DisplayMessage[] {
  const events = values.map(asResponseEvent).filter((event): event is JsonRecord => event !== null);
  if (events.length === 0) return [];
  const terminal = responseStreamTerminal(values);
  if (terminal && Array.isArray(terminal.output) && terminal.output.length > 0) {
    const messages = responseOutputMessages(terminal.output, stripMarkers);
    const error = asObject(terminal.error);
    if (error && typeof error.message === "string") {
      messages.push({ role: "error", roleLabel: "错误", content: error.message, toolCalls: [] });
    }
    return messages;
  }
  // The stream ended before response.completed: aggregate the deltas seen so far.
  let reasoning = "";
  let content = "";
  let refusal = "";
  const calls = new Map<string, DisplayToolCall>();
  for (const event of events) {
    const type = event.type as string;
    if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
      reasoning += event.delta;
    } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
      content += event.delta;
    } else if (type === "response.refusal.delta" && typeof event.delta === "string") {
      refusal += event.delta;
    } else if (type === "response.output_item.added") {
      const item = asObject(event.item);
      if (item && (item.type === "function_call" || item.type === "custom_tool_call")) {
        const id = typeof item.id === "string" ? item.id : `tool_${calls.size + 1}`;
        calls.set(id, {
          id: typeof item.call_id === "string" ? item.call_id : id,
          name: typeof item.name === "string" ? item.name : "未命名工具",
          arguments: "",
        });
      }
    } else if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
      const known = typeof event.item_id === "string" ? calls.get(event.item_id) : undefined;
      if (known && typeof event.delta === "string") known.arguments += event.delta;
    } else if (type === "response.output_item.done") {
      const item = asObject(event.item);
      if (item && (item.type === "function_call" || item.type === "custom_tool_call")) {
        const known = typeof item.id === "string" ? calls.get(item.id) : undefined;
        const payload = item.type === "custom_tool_call" ? item.input : item.arguments;
        if (known && typeof payload === "string" && payload) known.arguments = payload;
      }
    }
  }
  return buildAggregatedMessages({
    reasoning: stripMarkers ? cleanMarkers(reasoning) : reasoning.trim(),
    content: stripMarkers ? cleanMarkers(content || refusal) : (content || refusal).trim(),
    toolCalls: [...calls.values()],
  });
}

/** Collect messages from a body, concatenating streaming chunks into one box per kind. */
function collectBodyMessages(value: DebugRawBody | JsonRecord | undefined, stripMarkers: boolean): DisplayMessage[] {
  const values = parsedBodyValues(value);
  if (values.some(isStreamingChunk)) {
    const aggregated = aggregateStreamingMessages(values, stripMarkers);
    if (aggregated.length > 0) return aggregated;
  }
  if (values.some(isResponseStreamEvent)) {
    const aggregated = aggregateResponseStreamEvents(values, stripMarkers);
    if (aggregated.length > 0) return aggregated;
  }
  return values.flatMap(collectMessages);
}

function collectMessages(value: unknown): DisplayMessage[] {
  const source = asObject(value);
  // Responses API payloads carry `input`/`output` item arrays (plus optional
  // `instructions`) instead of chat `messages`/`choices`.
  if (source && (source.object === "response" || source.input !== undefined || Array.isArray(source.output))) {
    return collectResponseMessages(source);
  }
  const candidates: unknown[] = [];
  if (Array.isArray(source?.messages)) candidates.push(...source.messages);
  if (Array.isArray(source?.choices)) {
    for (const choice of source.choices) {
      const item = asObject(choice);
      if (item?.message) candidates.push(item.message);
      else if (item?.delta) candidates.push(item.delta);
    }
  }
  if (source?.role) {
    candidates.push(source);
  }
  return candidates.flatMap(splitMessage);
}

const fieldNames: Record<string, string> = {
  model: "模型",
  stream: "流式输出",
  temperature: "温度",
  top_p: "Top P",
  max_tokens: "最大令牌数",
  max_output_tokens: "最大输出令牌数",
  tool_choice: "工具选择",
  tools: "工具",
  parallel_tool_calls: "并行工具调用",
  response_format: "响应格式",
  object: "对象类型",
  id: "请求 ID",
  created: "创建时间",
  created_at: "创建时间",
  finish_reason: "结束原因",
  status: "状态",
  instructions: "指令",
  previous_response_id: "上一响应 ID",
  store: "存储",
  reasoning: "推理",
  text: "文本格式",
  metadata: "元数据",
  incomplete_details: "未完成详情",
  background: "后台运行",
  usage: "用量",
  error: "错误",
};

function recordFields(value: unknown): DisplayField[] {
  const source = asObject(value);
  if (!source) return [];
  return Object.entries(source)
    .filter(([key, item]) => !["messages", "input", "output", "choices", "content"].includes(key) && item !== undefined)
    .map(([key, item]) => ({
      label: fieldNames[key] ?? key,
      value: displayValue(item),
    }));
}

function isDebugRawBody(value: unknown): value is DebugRawBody {
  const body = asObject(value);
  return Boolean(body) && typeof body.body === "string" && typeof body.contentType === "string";
}

function parsedBodyValues(value: DebugRawBody | JsonRecord | undefined): unknown[] {
  if (!value) return [];
  if (!isDebugRawBody(value)) return [value];
  if (value.contentType === "text/event-stream") {
    return value.body.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("data:")) return [];
      const data = line.slice(5).trimStart();
      if (!data || data === "[DONE]") return [];
      try {
        return [JSON.parse(data)];
      } catch {
        return [];
      }
    });
  }
  try {
    return [JSON.parse(value.body)];
  } catch {
    return [];
  }
}

function rawBodyText(value: DebugRawBody | JsonRecord | undefined): string {
  if (!value) return "";
  return isDebugRawBody(value) ? value.body : pretty(value);
}

function bodyContentType(value: DebugRawBody | JsonRecord | undefined): string {
  return isDebugRawBody(value) ? value.contentType : "application/json";
}

function callTitle(call: Pick<DebugUpstreamCall, "type" | "round" | "attempt">): string {
  const base = call.type === "repair"
    ? `纠错轮 ${call.round}`
    : call.type === "continuation"
      ? `续写轮 ${call.round}`
      : "首次请求";
  return call.attempt > 1 ? `${base} · 上游重试 ${call.attempt - 1}` : base;
}

const tracesCache = new WeakMap<DebugRecord, ConversationTrace[]>();

function recordTraces(record: DebugRecord): ConversationTrace[] {
  const cached = tracesCache.get(record);
  if (cached) return cached;
  const traces = buildRecordTraces(record);
  tracesCache.set(record, traces);
  return traces;
}

function buildRecordTraces(record: DebugRecord): ConversationTrace[] {
  const traces: ConversationTrace[] = [{
    key: `${record.id}:client`,
    record,
    direction: "client",
    title: "客户端请求",
    subtitle: record.endpoint,
    request: record.clientRequest,
    response: record.clientResponse,
    status: record.status,
    error: record.error,
  }];
  if (record.upstreamCalls?.length) {
    traces.push(...record.upstreamCalls.map((call) => ({
      key: `${record.id}:upstream:${call.sequence}`,
      record,
      direction: "upstream" as const,
      title: callTitle(call),
      subtitle: call.accountLabel || call.accountId || "上游账号未分配",
      request: call.request,
      response: call.response,
      status: call.responseStatus ?? record.status,
      error: call.error,
    })));
  } else if (record.upstreamRequest || record.upstreamResponse) {
    traces.push({
      key: `${record.id}:upstream:legacy`,
      record,
      direction: "upstream",
      title: "上游请求",
      subtitle: record.accountLabel || record.accountId || "上游账号未分配",
      request: record.upstreamRequest ?? {},
      response: record.upstreamResponse,
      status: record.status,
      error: record.error,
    });
  }
  return traces;
}

const selectedRecordTraces = computed(() => (selectedRecord.value ? recordTraces(selectedRecord.value) : []));
const selectedTrace = computed(() => selectedRecordTraces.value.find((trace) => trace.key === selectedTraceKey.value) ?? selectedRecordTraces.value[0]);
const upstreamCallCount = computed(() => records.value.reduce((total, record) =>
  total + (record.upstreamCalls?.length ?? (record.legacyUpstream ? 1 : 0)), 0));

function presentBody(value: DebugRawBody | JsonRecord | undefined, options?: { stripMarkers?: boolean }): BodyPresentation {
  const values = parsedBodyValues(value);
  const responseStreaming = values.some(isResponseStreamEvent);
  const streaming = responseStreaming || values.some(isStreamingChunk);
  const messages = collectBodyMessages(value, options?.stripMarkers ?? true);
  const raw = rawBodyText(value);
  // Responses stream events are envelope noise; surface the terminal response
  // object's metadata instead of per-event fields.
  const terminal = responseStreaming ? responseStreamTerminal(values) : null;
  const fields = responseStreaming
    ? (terminal ? recordFields(terminal) : [])
    : values.flatMap(recordFields);
  return {
    contentType: bodyContentType(value),
    raw,
    fields: streaming ? dedupeFields(fields) : fields,
    messages: messages.length > 0 || !raw
      ? messages
      : [{ role: "raw", roleLabel: "原始文本", content: raw, toolCalls: [] }],
  };
}

function dedupeFields(fields: DisplayField[]): DisplayField[] {
  const seen = new Set<string>();
  const result: DisplayField[] = [];
  for (const field of fields) {
    if (seen.has(field.label)) continue;
    seen.add(field.label);
    result.push(field);
  }
  return result;
}

function traceRequest(trace: ConversationTrace): BodyPresentation {
  return presentBody(trace.request, { stripMarkers: trace.direction === "client" });
}

function traceResponse(trace: ConversationTrace): BodyPresentation | undefined {
  return trace.response ? presentBody(trace.response, { stripMarkers: trace.direction === "client" }) : undefined;
}

// ---- Prev / next record navigation ----
const selectedRecordIndex = computed(() => {
  if (!selectedRecordId.value) return -1;
  return filteredRecords.value.findIndex((record) => record.id === selectedRecordId.value);
});

function gotoRecord(offset: number): void {
  const next = filteredRecords.value[selectedRecordIndex.value + offset] ?? (selectedRecordIndex.value === -1 ? filteredRecords.value[0] : undefined);
  if (!next) return;
  void selectRecord(next.id);
  void nextTick(() => document.querySelector(".trace-group.active")?.scrollIntoView({ block: "nearest" }));
}

// Sidebar rows are precomputed once per records/filter change so rendering
// never rebuilds upstream items per item per render.
function summaryUpstreamItems(record: DebugRecordSummary): SidebarUpstreamItem[] {
  if (record.upstreamCalls?.length) {
    return record.upstreamCalls.map((call) => {
      const status = call.responseStatus ?? record.status;
      return {
        key: `${record.id}:upstream:${call.sequence}`,
        title: callTitle(call),
        subtitle: call.accountLabel || call.accountId || "上游账号未分配",
        status,
        failed: status >= 400 || Boolean(call.error),
      };
    });
  }
  if (record.legacyUpstream) {
    return [{
      key: `${record.id}:upstream:legacy`,
      title: "上游请求",
      subtitle: record.accountLabel || record.accountId || "上游账号未分配",
      status: record.status,
      failed: record.status >= 400 || Boolean(record.error),
    }];
  }
  return [];
}

const sidebarItems = computed<SidebarItem[]>(() => filteredRecords.value.map((record) => ({
  record,
  upstream: summaryUpstreamItems(record),
})));

// Parse the selected trace bodies once per selection instead of on every render.
const selectedRequest = computed(() => (selectedTrace.value ? traceRequest(selectedTrace.value) : null));
const selectedResponse = computed(() => (selectedTrace.value ? traceResponse(selectedTrace.value) : null));

watch(accountQuery, () => {
  if (typeof window === "undefined") return;
  window.clearTimeout(accountQueryTimer);
  accountQueryTimer = window.setTimeout(() => {
    accountPageNumber.value = 1;
    void requestAccountPage();
  }, 250);
});

watch(autoRefresh, (enabled) => {
  if (typeof window === "undefined") return;
  window.clearInterval(autoRefreshTimer);
  autoRefreshTimer = undefined;
  if (enabled) {
    autoRefreshTimer = window.setInterval(() => {
      void loadDashboard({ silent: true });
      if (view.value === "accounts") void requestAccountPage();
    }, 5_000);
  }
}, { immediate: true });

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (view.value !== "records" || !token.value || dialogOpen.value) return;
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, button, [contenteditable='true'], [role='tab'], [role='menu'], [role='listbox'], [role='option']")) return;
  event.preventDefault();
  gotoRecord(event.key === "ArrowLeft" ? -1 : 1);
}

onMounted(() => {
  currentTime.value = Date.now();
  clockTimer = window.setInterval(() => {
    currentTime.value = Date.now();
  }, 30_000);
  if (token.value) {
    void loadDashboard();
    if (view.value === "accounts") void refreshAccountWorkspace();
  }
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  window.clearInterval(autoRefreshTimer);
  window.clearInterval(clockTimer);
  window.clearTimeout(accountQueryTimer);
  window.removeEventListener("keydown", onKeydown);
});
</script>
<template>
  <div class="app-shell" :data-theme="theme">
    <header v-if="!token" class="topbar">
      <div class="wordmark">
        <span class="wordmark-mark"><AppIcon name="activity" :size="16" /></span>
        <span>NeuralWatt 网关</span>
      </div>
    </header>

    <main v-if="!token" class="access-page">
      <section class="access-panel" aria-labelledby="access-title">
        <p class="section-kicker">管理员入口</p>
        <h1 id="access-title">网关控制台</h1>
        <p class="access-copy">请输入服务端管理员令牌继续。</p>
        <form class="access-form" @submit.prevent="useToken">
          <label for="admin-token">管理员令牌</label>
          <input id="admin-token" v-model="tokenDraft" name="admin-token" type="password" autocomplete="current-password" spellcheck="false" />
          <button class="button button-primary" type="submit">进入控制台</button>
        </form>
        <p v-if="loginError" class="error-line" role="alert">{{ loginError }}</p>
      </section>
    </main>

    <WorkspaceShell v-else :theme="theme" :workspace="view" :loading="isLoading" :connected="isConnected" :auto-refresh="autoRefresh" @select="selectView" @refresh="loadDashboard()" @toggle-auto-refresh="autoRefresh = !autoRefresh" @change-theme="changeTheme" @sign-out="signOut">
      <Transition name="page-fade" mode="out-in">
      <OverviewWorkspace v-if="view === 'overview'" key="overview" :snapshot="overviewSnapshot" :analytics="analytics" :detail="analyticsResult" :analytics-range="analyticsRange" :analytics-granularity="analyticsGranularity" :analytics-sort="analyticsSort" :analytics-model="analyticsModel" :custom-from="analyticsCustomFrom" :custom-to="analyticsCustomTo" :loading-analytics="isLoadingAnalytics" :account-overview="accountOverview" :proxies="proxies" :egresses="schedulerRuntime.egresses" @navigate="navigateFromOverview" @set-range="setAnalyticsRange" @set-granularity="setAnalyticsGranularity" @set-sort="setAnalyticsSort" @set-model="setAnalyticsModel" @update:custom-from="analyticsCustomFrom = $event" @update:custom-to="analyticsCustomTo = $event" @load-custom="loadAnalytics" />
      <AccountsWorkspace v-else-if="view === 'accounts'" key="accounts" v-model:query="accountQuery" v-model:expanded-id="expandedAccountId" :accounts="accountPage" :groups="accountGroups" :group-summary="groupSummary" :pagination="accountPagination" :group-filter="accountGroupFilter" :status-filter="accountStatusFilter" :sort="accountSort" :page-size="accountPageSize" :proxies="proxies" :scheduler="settings.scheduler" :busy-ids="busyAccountIds" :loading="isLoadingAccounts" :secret-reset-token="secretResetToken" :copy-secret="copyCredential" @select-group="selectAccountGroup" @set-status="setAccountStatus" @set-sort="setAccountSort" @set-page-size="setAccountPageSize" @set-page="setAccountPage" @add="openAddAccount" @add-group="openCreateGroup" @edit-group="openEditGroup" @manage-keys="openKeyManager" @save-membership="saveAccountMembership" @verify="verifyAccount" @manage-proxy="openProxyEditor" @assign-proxy="assignProxy" @fetch-models="fetchAccountModels" @edit-models="openModelEditor" @edit-limits="openLimitEditor" @toggle="toggleAccount" @remove="askRemoveAccount" />
      <ProxyPoolWorkspace v-else-if="view === 'proxies'" key="proxies" v-model:import-text="proxyImportText" v-model:filter="proxyFilter" :proxies="proxies" :draft="proxyPoolDraft" :import-results="proxyImportResults" :busy-ids="busyProxyIds" :direct-account-count="accountOverview.direct" :importing="isImportingProxies" :checking-all="isCheckingProxies" :assigning-direct="isAssigningDirectProxies" :saving="isSavingProxyPool" @update-policy="updateProxyPolicy" @import="importProxies" @check="checkProxyEntry" @check-many="checkProxyPool" @assign-direct="assignProxiesToDirectAccounts" @delete="deleteProxyEntry" @save-policies="saveProxyPoolSettings" />
      <SchedulerWorkspace v-else-if="view === 'scheduler'" key="scheduler" :draft="schedulerDraft" :runtime="schedulerRuntime" :saving="isSavingScheduler" @update-field="updateSchedulerField" @save="saveSchedulerSettings" />
      <RecordsWorkspace v-else-if="view === 'records'" key="records" v-model:query="recordQuery" v-model:filter="recordFilter" v-model:raw-trace-key="rawTraceKey" :records="records" :filtered-records="filteredRecords" :sidebar-items="sidebarItems" :selected-record-id="selectedRecordId" :selected-trace-key="selectedTraceKey" :selected-trace="selectedTrace" :selected-request="selectedRequest" :selected-response="selectedResponse" :loading-detail="isLoadingRecord" :recording="settings.recordMessages" :failed-count="failedRecordCount" :upstream-call-count="upstreamCallCount" :tool-first-pass-rate="toolFirstPassRate" :tool-adapter-count="toolAdapterRecords.length" :selected-record-index="selectedRecordIndex" :clearing="isClearingRecords" @toggle-recording="setRecording" @refresh="loadRecords" @clear="askClearRecords" @select-record="selectRecord" @goto="gotoRecord" />
      <GatewaySettingsWorkspace v-else key="settings" :settings="settings" :config="config" :analytics="analytics" :retention="analyticsRetention" :cleanup-cutoff="cleanupCutoff" :all-models="allModels" v-model:minimum-output-tokens-draft="minimumOutputTokensDraft" :saving-budget="isSavingMinimumOutputTokens" :refreshing-prices="isRefreshingPrices" :saving-retention="isSavingRetention" :previewing-cleanup="isPreviewingCleanup" :secret-reset-token="secretResetToken" :copy-secret="copyCredential" @save-budget="saveMinimumOutputTokens" @set-tool-format="setToolCallFormat" @set-preamble="setPreambleVerbosity" @set-model-tool-format="setModelToolCallFormat" @set-model-preamble="setModelPreambleVerbosity" @refresh-prices="refreshAnalyticsPrices" @save-retention="saveAnalyticsRetention" @update:cleanup-cutoff="cleanupCutoff = $event" @preview-cleanup="previewAnalyticsCleanup" @sign-out="signOut" />
      </Transition>
    </WorkspaceShell>

    <AppDialog :open="showAddAccount" title="添加账号" description="保存时将验证门户登录，验证成功后加入连接池。" :busy="isSaving" @update:open="showAddAccount = $event">
      <form class="modal-form" @submit.prevent="addAccount">
        <div class="modal-body">
          <label for="account-label">账号名称</label>
          <input id="account-label" v-model="newAccount.label" type="text" maxlength="120" placeholder="主账号 Kimi" />
          <label for="account-email">门户邮箱</label>
          <input id="account-email" v-model="newAccount.email" name="portal-email" type="email" maxlength="320" autocomplete="username" spellcheck="false" required />
          <label for="account-password">门户密码</label>
          <input id="account-password" v-model="newAccount.password" type="password" maxlength="4096" autocomplete="new-password" required />
          <fieldset v-if="accountGroups.length" class="modal-checkbox-group"><legend>账号分组</legend><label v-for="group in accountGroups" :key="group.id"><input v-model="newAccount.groupIds" type="checkbox" :value="group.id" /><span>{{ group.name }}</span></label></fieldset>
          <div class="field-row">
            <div>
              <label for="account-weight">权重</label>
              <input id="account-weight" v-model.number="newAccount.weight" type="number" min="1" max="100" step="1" required />
            </div>
            <div>
              <label for="account-proxy">出口代理（可选）</label>
              <input id="account-proxy" v-model="newAccount.proxy" type="text" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="socks5://user:pass@host:1080" />
            </div>
          </div>
        </div>
        <footer class="modal-foot">
          <button class="button button-quiet" type="button" :disabled="isSaving" @click="showAddAccount = false">取消</button>
          <button class="button button-primary" type="submit" :disabled="isSaving" :aria-busy="isSaving"><span v-if="isSaving" class="spinner" aria-hidden="true"></span>{{ isSaving ? "验证中" : "验证并添加" }}</button>
        </footer>
      </form>
    </AppDialog>

    <AppDialog :open="Boolean(groupEditor)" :title="groupEditor?.group ? '编辑账号分组' : '创建账号分组'" :description="groupEditor?.group ? '名称、说明和启用状态立即影响分组 Key。' : '分组用于约束账号调度范围和 API Key 访问。'" :busy="isSavingGroup" @update:open="!$event && (groupEditor = null)">
      <form v-if="groupEditor" class="modal-form" @submit.prevent="saveAccountGroup">
        <div class="modal-body"><label for="group-name">分组名称</label><input id="group-name" v-model="groupEditor.name" type="text" maxlength="120" required /><label for="group-description">说明（可选）</label><textarea id="group-description" v-model="groupEditor.description" rows="3" maxlength="500"></textarea><label v-if="groupEditor.group" class="modal-check"><input v-model="groupEditor.enabled" type="checkbox" /><span>允许该分组的 Key 发起新请求</span></label></div>
        <footer class="modal-foot"><button v-if="groupEditor.group" class="button button-danger modal-danger-left" type="button" :disabled="isSavingGroup" @click="askRemoveGroup(groupEditor.group)">删除分组</button><button class="button button-quiet" type="button" :disabled="isSavingGroup" @click="groupEditor = null">取消</button><button class="button button-primary" type="submit" :disabled="isSavingGroup || !groupEditor.name.trim()">{{ isSavingGroup ? '保存中' : '保存分组' }}</button></footer>
      </form>
    </AppDialog>

    <AppDialog :open="Boolean(keyManagerGroup)" title="分组 API Key" :description="keyManagerGroup ? `分组「${keyManagerGroup.name}」 · 每个 Key 仅能调度该组账号` : ''" :busy="isSavingGroupKey" wide @update:open="!$event && closeKeyManager()">
      <div v-if="keyManagerGroup" class="modal-form"><div class="modal-body">
        <section v-if="oneTimeGroupSecret" class="one-time-secret"><strong>请立即保存此 Key</strong><p>明文只显示这一次，关闭对话框后无法再次查看。</p><SecretValue :value="oneTimeGroupSecret" :label="`${keyManagerGroup.name} 的 API Key`" :reset-token="secretResetToken" :copy="copyCredential" /></section>
        <form class="key-create-row" @submit.prevent="createGroupKey"><label for="group-key-name">新 Key 名称</label><div><input id="group-key-name" v-model="keyNameDraft" type="text" maxlength="120" placeholder="例如：生产客户端" /><button class="button button-primary" type="submit" :disabled="isSavingGroupKey || !keyNameDraft.trim()"><AppIcon name="plus" :size="13" />创建 Key</button></div></form>
        <div v-if="groupApiKeys.length" class="group-key-list"><article v-for="key in groupApiKeys" :key="key.id"><div><strong>{{ key.name }}</strong><code>{{ key.prefix }}…</code><span class="badge" :class="key.enabled ? 'good' : 'muted'">{{ key.enabled ? '已启用' : '已停用' }}</span></div><div class="detail-actions"><button class="button button-quiet" type="button" :disabled="isSavingGroupKey" @click="rotateGroupKey(key)"><AppIcon name="refresh-cw" :size="13" />轮换</button><button class="button button-quiet" type="button" :disabled="isSavingGroupKey" @click="toggleGroupKey(key)">{{ key.enabled ? '停用' : '启用' }}</button><button class="button button-danger" type="button" :disabled="isSavingGroupKey" @click="pendingKeyRemoval = key">撤销</button></div></article></div><div v-else class="workspace-empty"><strong>尚未创建分组 Key</strong><p>创建后，客户端只能访问此分组中的账号。</p></div>
      </div><footer class="modal-foot"><button class="button button-quiet" type="button" @click="closeKeyManager">关闭</button></footer></div>
    </AppDialog>

    <AppDialog :open="Boolean(proxyEditor)" title="设置出口代理" :description="proxyEditor ? `账号「${proxyEditor.account.label}」 · 当前：${proxyEditor.account.proxy ?? '直连'}` : ''" :busy="Boolean(proxyEditor && isAccountBusy(proxyEditor.account.id))" @update:open="!$event && (proxyEditor = null)">
      <form v-if="proxyEditor" class="modal-form" @submit.prevent="saveProxy">
        <div class="modal-body">
          <label for="proxy-input">代理地址</label>
          <input id="proxy-input" v-model="proxyEditor.value" type="text" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="http://host:8080 或 socks5://user:pass@host:1080" />
          <p class="field-hint">支持 http / https / socks4 / socks5，可带认证。留空并保存将清除代理；更换出口不会主动退出账号，门户拒绝现有会话时才重新登录。</p>
        </div>
        <footer class="modal-foot">
          <button class="button button-quiet" type="button" :disabled="isAccountBusy(proxyEditor.account.id)" @click="proxyEditor = null">取消</button>
          <button class="button button-primary" type="submit" :disabled="isAccountBusy(proxyEditor.account.id)" :aria-busy="isAccountBusy(proxyEditor.account.id)"><span v-if="isAccountBusy(proxyEditor.account.id)" class="spinner" aria-hidden="true"></span>保存</button>
        </footer>
      </form>
    </AppDialog>

    <AppDialog :open="Boolean(modelEditor)" title="编辑模型列表" :description="modelEditor ? `账号「${modelEditor.account.label}」 · 当前 ${modelEditor.account.models.length} 个模型` : ''" :busy="Boolean(modelEditor && isAccountBusy(modelEditor.account.id))" @update:open="!$event && (modelEditor = null)">
      <form v-if="modelEditor" class="modal-form" @submit.prevent="saveModels">
        <div class="modal-body">
          <label for="models-input">模型 ID（每行一个，或用逗号分隔）</label>
          <textarea id="models-input" v-model="modelEditor.value" rows="8" spellcheck="false" placeholder="deepseek-v4-flash&#10;glm-5.2"></textarea>
          <p class="field-hint">保存将替换当前列表；「自动获取」会追加并去重。</p>
        </div>
        <footer class="modal-foot">
          <button class="button button-quiet" type="button" :disabled="isAccountBusy(modelEditor.account.id)" @click="modelEditor = null">取消</button>
          <button class="button button-primary" type="submit" :disabled="isAccountBusy(modelEditor.account.id)" :aria-busy="isAccountBusy(modelEditor.account.id)"><span v-if="isAccountBusy(modelEditor.account.id)" class="spinner" aria-hidden="true"></span>保存</button>
        </footer>
      </form>
    </AppDialog>

    <AppDialog :open="Boolean(limitEditor)" title="账号调度限额" :description="limitEditor ? `账号「${limitEditor.account.label}」 · 留空继承全局配置` : ''" :busy="Boolean(limitEditor && isAccountBusy(limitEditor.account.id))" wide @update:open="!$event && (limitEditor = null)">
      <form v-if="limitEditor" class="modal-form" @submit.prevent="saveAccountLimits">
        <div class="modal-body">
          <div class="field-row">
            <div><label for="account-rpm-override">账号 RPM</label><input id="account-rpm-override" v-model="limitEditor.accountRpm" type="number" min="1" max="100000" placeholder="继承全局" /></div>
            <div><label for="account-concurrency-override">账号模型并发</label><input id="account-concurrency-override" v-model="limitEditor.accountModelConcurrency" type="number" min="1" max="1000" placeholder="继承全局" /></div>
          </div>
          <div v-if="limitEditor.account.models.length" class="limit-model-list">
            <span class="account-models-label">按模型覆盖</span>
            <label v-for="model in limitEditor.account.models" :key="model" class="limit-model-row"><span class="mono">{{ model }}</span><input v-model="limitEditor.modelConcurrency[model]" type="number" min="1" max="1000" :placeholder="`继承 ${limitEditor.account.schedulerOverrides?.accountModelConcurrency ?? settings.scheduler.accountModelConcurrency}`" /></label>
          </div>
        </div>
        <footer class="modal-foot"><button class="button button-quiet" type="button" :disabled="isAccountBusy(limitEditor.account.id)" @click="limitEditor = null">取消</button><button class="button button-primary" type="submit" :disabled="isAccountBusy(limitEditor.account.id)" :aria-busy="isAccountBusy(limitEditor.account.id)"><span v-if="isAccountBusy(limitEditor.account.id)" class="spinner" aria-hidden="true"></span>保存</button></footer>
      </form>
    </AppDialog>

    <AppConfirmDialog :open="Boolean(pendingGroupRemoval)" title="删除账号分组" :description="pendingGroupRemoval ? `确定删除分组「${pendingGroupRemoval.name}」吗？将从 ${pendingGroupRemoval.accountCount} 个账号移除该分组，并撤销 ${pendingGroupRemoval.apiKeyCount} 个 API Key。` : ''" confirm-label="删除分组" busy-label="删除中" :busy="isSavingGroup" return-focus=".account-group-rail" @update:open="!$event && (pendingGroupRemoval = null)" @confirm="confirmRemoveGroup" />

    <AppConfirmDialog :open="Boolean(pendingKeyRemoval)" title="撤销分组 API Key" :description="pendingKeyRemoval ? `确定撤销 Key「${pendingKeyRemoval.name}」吗？使用该 Key 的新请求将立即认证失败。` : ''" confirm-label="撤销 Key" busy-label="撤销中" :busy="isSavingGroupKey" return-focus=".group-key-list" @update:open="!$event && (pendingKeyRemoval = null)" @confirm="confirmRemoveGroupKey" />

    <AppConfirmDialog
      :open="Boolean(pendingRemoval)"
      title="移除账号"
      :description="pendingRemoval ? `确定移除账号「${pendingRemoval.label}」吗？该账号的会话将被删除，此操作不可撤销。` : ''"
      confirm-label="移除"
      busy-label="移除中"
      :busy="Boolean(pendingRemoval && isAccountBusy(pendingRemoval.id))"
      return-focus=".accounts-workspace .search-field input"
      @update:open="!$event && (pendingRemoval = null)"
      @confirm="confirmRemoveAccount"
    />

    <AppConfirmDialog
      :open="showClearConfirm"
      title="清空聊天记录"
      :description="`确定清空全部 ${records.length} 条聊天记录吗？此操作不可撤销。`"
      confirm-label="清空全部"
      busy-label="清空中"
      :busy="isClearingRecords"
      return-focus=".records-workspace .more-trigger"
      @update:open="showClearConfirm = $event"
      @confirm="confirmClearRecords"
    />

    <AppConfirmDialog
      :open="showCleanupConfirm"
      title="清理分析数据"
      :description="cleanupDescription"
      confirm-label="确认清理"
      busy-label="清理中"
      :busy="isCleaningAnalytics"
      return-focus=".gateway-analytics-cleanup button"
      @update:open="showCleanupConfirm = $event"
      @confirm="confirmAnalyticsCleanup"
    />

    <div class="toast-stack" aria-live="polite">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind">
        <AppIcon :name="toast.kind === 'error' ? 'alert-circle' : 'check-circle'" :size="15" />
        <span class="toast-text">{{ toast.text }}</span>
        <button class="toast-close" type="button" aria-label="关闭通知" @click="dismissToast(toast.id)"><AppIcon name="x" :size="13" /></button>
      </div>
    </div>
  </div>
</template>
