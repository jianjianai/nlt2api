<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import AppConfirmDialog from "./components/ui/AppConfirmDialog.vue";
import AppIcon from "./components/ui/AppIcon.vue";
import OverviewWorkspace from "./components/OverviewWorkspace.vue";
import WorkspaceShell from "./components/WorkspaceShell.vue";
// Heavier workspaces load on first visit; the first paint ships only the shell.
const ProxyPoolWorkspace = defineAsyncComponent(() => import("./components/ProxyPoolWorkspace.vue"));
const TicketPoolWorkspace = defineAsyncComponent(() => import("./components/TicketPoolWorkspace.vue"));
const MintersWorkspace = defineAsyncComponent(() => import("./components/MintersWorkspace.vue"));
const SettingsWorkspace = defineAsyncComponent(() => import("./components/SettingsWorkspace.vue"));
import {
  DEFAULT_THEME,
  parseTheme,
  parseWorkspace,
  THEME_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from "./utils/admin-ui.ts";
import type {
  CheckOutcome,
  GatewaySettings,
  ImportSummary,
  MinterSessionPublic,
  OverviewSnapshot,
  ProxyFilter,
  ProxyKind,
  ProxyPublic,
  ProxyStatus,
  SettingBounds,
  SettingKey,
  ThemeId,
  TicketPublic,
  WorkspaceId,
} from "./types/admin.ts";

const token = ref(typeof window === "undefined" ? "" : sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
const tokenDraft = ref(token.value);
const loginError = ref("");
const view = ref<WorkspaceId>(typeof window === "undefined" ? "overview" : parseWorkspace(localStorage.getItem(WORKSPACE_STORAGE_KEY)));
const theme = ref<ThemeId>(typeof window === "undefined" ? DEFAULT_THEME : parseTheme(localStorage.getItem(THEME_STORAGE_KEY)));

const overview = shallowRef<OverviewSnapshot | null>(null);
const settings = shallowRef<GatewaySettings | null>(null);
const settingsDraft = shallowRef<GatewaySettings | null>(null);
const settingBounds = shallowRef<SettingBounds | null>(null);
const proxies = shallowRef<ProxyPublic[]>([]);
const proxyTotal = ref(0);
const proxyPage = ref(1);
const proxyPageSize = ref(50);
const selectedProxyIds = ref(new Set<string>());
const pendingBulkRemoval = ref(false);
const tickets = shallowRef<TicketPublic[]>([]);
const ticketAvailable = ref(0);
const ticketTotal = ref(0);
const minters = shallowRef<MinterSessionPublic[]>([]);
const minterOnline = ref(0);
const minterInflight = ref(0);

const proxyFilter = ref<ProxyFilter>("all");
const importText = ref("");
const importProtocol = ref<ProxyKind>("http");
const importSummary = shallowRef<ImportSummary | null>(null);

const isLoading = ref(false);
const isConnected = ref(false);
const isImporting = ref(false);
const isChecking = ref(false);
const isClearingTickets = ref(false);
const isSavingSettings = ref(false);
const isRemovingProxies = ref(false);
const busyProxyIds = ref(new Set<string>());
const busyMinterIds = ref(new Set<string>());
const pendingProxyRemoval = shallowRef<ProxyPublic | null>(null);
const pendingTicketClear = ref(false);
const autoRefresh = ref(true);
const currentTime = ref(Date.now());

/** Screenshot dialog state for the minters workspace; App owns the API call. */
const screenshotSession = shallowRef<MinterSessionPublic | null>(null);
const screenshotKind = ref<"page" | "fullpage">("page");
const screenshotBusy = ref(false);
const screenshotError = ref<string | null>(null);
const screenshotImage = ref<string | null>(null);

interface ToastItem { id: number; kind: "success" | "error"; text: string }
const toasts = ref<ToastItem[]>([]);
let toastSeq = 0;

function pushToast(kind: ToastItem["kind"], text: string): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, kind, text }];
  window.setTimeout(() => dismissToast(id), kind === "error" ? 6_000 : 3_500);
}

function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function setBusy(target: typeof busyProxyIds, id: string, busy: boolean): void {
  const next = new Set(target.value);
  if (busy) next.add(id);
  else next.delete(id);
  target.value = next;
}

/** Admin fetch wrapper: attaches the token and unwraps the OpenAI error shape. */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "x-admin-token": token.value,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A proxy or the server may answer with an HTML page (e.g. 404/502 from
      // an edge layer) instead of JSON. Surface a readable error instead of
      // leaking the raw parser exception.
      throw new Error(`服务端返回了非 JSON 响应（HTTP ${response.status}）。`);
    }
  }
  if (!response.ok) {
    const error = payload.error as { message?: string; code?: string } | undefined;
    if (response.status === 401) signOut(error?.message ?? "管理令牌无效。");
    throw new Error(error?.message ?? `请求失败（${response.status}）。`);
  }
  return payload as T;
}

async function loadOverview(): Promise<void> {
  const payload = await api<{ overview: OverviewSnapshot; settings: GatewaySettings }>("/api/admin/overview");
  overview.value = payload.overview;
  settings.value = payload.settings;
  if (!settingsDraft.value) settingsDraft.value = { ...payload.settings };
}

async function loadProxies(): Promise<void> {
  const query = new URLSearchParams({ page: String(proxyPage.value), pageSize: String(proxyPageSize.value) });
  if (proxyFilter.value !== "all") query.set("status", proxyFilter.value);
  const payload = await api<{ entries: ProxyPublic[]; total: number }>(`/api/admin/proxies?${query}`);
  proxies.value = payload.entries;
  proxyTotal.value = payload.total;
  // Deselect ids that are no longer on this page (deleted, or filtered elsewhere).
  const visible = new Set(payload.entries.map((entry) => entry.id));
  selectedProxyIds.value = new Set([...selectedProxyIds.value].filter((id) => visible.has(id)));
}

async function loadTickets(): Promise<void> {
  const payload = await api<{ entries: TicketPublic[]; available: number; total: number }>("/api/admin/tickets");
  tickets.value = payload.entries;
  ticketAvailable.value = payload.available;
  ticketTotal.value = payload.total;
}

async function loadMinters(): Promise<void> {
  const payload = await api<{ entries: MinterSessionPublic[]; online: number; inflight: number }>("/api/admin/minters");
  minters.value = payload.entries;
  minterOnline.value = payload.online;
  minterInflight.value = payload.inflight;
}

async function loadSettings(): Promise<void> {
  const payload = await api<{ settings: GatewaySettings; bounds: SettingBounds }>("/api/admin/settings");
  settings.value = payload.settings;
  settingBounds.value = payload.bounds;
  if (!settingsDirty.value) settingsDraft.value = { ...payload.settings };
}

/** Loads only what the active workspace renders, plus the shared overview. */
async function refresh(): Promise<void> {
  if (!token.value) return;
  isLoading.value = true;
  try {
    await loadOverview();
    if (view.value === "proxies") await loadProxies();
    else if (view.value === "tickets") await loadTickets();
    else if (view.value === "minters") await loadMinters();
    else if (view.value === "settings") await loadSettings();
    isConnected.value = true;
  } catch (error) {
    isConnected.value = false;
    pushToast("error", errorText(error, "无法加载运行状态。"));
  } finally {
    isLoading.value = false;
  }
}

function signIn(): void {
  const value = tokenDraft.value.trim();
  if (!value) {
    loginError.value = "请输入管理令牌。";
    return;
  }
  loginError.value = "";
  token.value = value;
  sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
  void refresh();
}

function signOut(message?: string): void {
  token.value = "";
  tokenDraft.value = "";
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  overview.value = null;
  isConnected.value = false;
  if (message) loginError.value = message;
}

async function importProxies(): Promise<void> {
  isImporting.value = true;
  try {
    const summary = await api<ImportSummary>("/api/admin/proxies/import", {
      method: "POST",
      body: JSON.stringify({ text: importText.value, defaultProtocol: importProtocol.value }),
    });
    importSummary.value = summary;
    if (summary.imported > 0) importText.value = "";
    pushToast("success", `导入完成：新增 ${summary.imported}，重复 ${summary.duplicates}，无效 ${summary.invalid.length}`);
    await Promise.all([loadProxies(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "导入失败。"));
  } finally {
    isImporting.value = false;
  }
}

async function checkScope(scope: "pending" | "unavailable" | "all"): Promise<void> {
  isChecking.value = true;
  try {
    const outcome = await api<CheckOutcome>("/api/admin/proxies/check", {
      method: "POST",
      body: JSON.stringify({ scope }),
    });
    pushToast("success", `测活完成：${outcome.healthy}/${outcome.checked} 通过`);
    await Promise.all([loadProxies(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "测活失败。"));
  } finally {
    isChecking.value = false;
  }
}

async function checkProxy(proxy: ProxyPublic): Promise<void> {
  setBusy(busyProxyIds, proxy.id, true);
  try {
    const outcome = await api<CheckOutcome>(`/api/admin/proxies/${proxy.id}/check`, { method: "POST" });
    pushToast(outcome.healthy > 0 ? "success" : "error", outcome.healthy > 0 ? "测活通过。" : "测活失败，已记录一次故障。");
    await Promise.all([loadProxies(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "测活失败。"));
  } finally {
    setBusy(busyProxyIds, proxy.id, false);
  }
}

async function reactivateProxy(proxy: ProxyPublic): Promise<void> {
  setBusy(busyProxyIds, proxy.id, true);
  try {
    await api(`/api/admin/proxies/${proxy.id}`, { method: "PATCH", body: JSON.stringify({ reactivate: true }) });
    pushToast("success", "已重新启用，等待下一轮测活。");
    await Promise.all([loadProxies(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "操作失败。"));
  } finally {
    setBusy(busyProxyIds, proxy.id, false);
  }
}

function confirmBulkRemoval(): void {
  pendingBulkRemoval.value = true;
}

async function applyBulkRemoval(): Promise<void> {
  const ids = [...selectedProxyIds.value];
  if (ids.length === 0) {
    pendingBulkRemoval.value = false;
    return;
  }
  isRemovingProxies.value = true;
  try {
    await api("/api/admin/proxies/bulk", { method: "POST", body: JSON.stringify({ ids, action: "delete" }) });
    pendingBulkRemoval.value = false;
    selectedProxyIds.value = new Set();
    pushToast("success", `已删除 ${ids.length} 个代理，其凭证同时清除。`);
    await Promise.all([loadProxies(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "批量删除失败。"));
  } finally {
    isRemovingProxies.value = false;
  }
}

async function checkSelected(): Promise<void> {
  const ids = [...selectedProxyIds.value];
  if (ids.length === 0) return;
  isChecking.value = true;
  try {
    const outcome = await api<CheckOutcome>("/api/admin/proxies/bulk", { method: "POST", body: JSON.stringify({ ids, action: "check" }) });
    pushToast("success", `批量测活：${outcome.healthy}/${outcome.checked} 通过`);
    await Promise.all([loadProxies(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "批量测活失败。"));
  } finally {
    isChecking.value = false;
  }
}

async function confirmProxyRemoval(): Promise<void> {
  const proxy = pendingProxyRemoval.value;
  if (!proxy) return;
  setBusy(busyProxyIds, proxy.id, true);
  try {
    await api(`/api/admin/proxies/${proxy.id}`, { method: "DELETE" });
    pendingProxyRemoval.value = null;
    pushToast("success", "代理已删除，其凭证同时清除。");
    await Promise.all([loadProxies(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "删除失败。"));
  } finally {
    setBusy(busyProxyIds, proxy.id, false);
  }
}


async function confirmTicketClear(): Promise<void> {
  isClearingTickets.value = true;
  try {
    const payload = await api<{ removed: number }>("/api/admin/tickets", { method: "DELETE" });
    pendingTicketClear.value = false;
    pushToast("success", `已清空 ${payload.removed} 组凭证。`);
    await Promise.all([loadTickets(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "清空失败。"));
  } finally {
    isClearingTickets.value = false;
  }
}

async function disconnectMinter(session: MinterSessionPublic): Promise<void> {
  setBusy(busyMinterIds, session.id, true);
  try {
    await api(`/api/admin/minters/${session.id}/disconnect`, { method: "POST" });
    pushToast("success", "已断开该授权服务。");
    await Promise.all([loadMinters(), loadOverview()]);
  } catch (error) {
    pushToast("error", errorText(error, "断开失败。"));
  } finally {
    setBusy(busyMinterIds, session.id, false);
  }
}

function openScreenshot(session: MinterSessionPublic, kind: "page" | "fullpage"): void {
  screenshotSession.value = session;
  screenshotKind.value = kind;
  screenshotBusy.value = true;
  screenshotError.value = null;
  screenshotImage.value = null;
  void captureScreenshot(session, kind);
}

async function captureScreenshot(session: MinterSessionPublic, kind: "page" | "fullpage"): Promise<void> {
  screenshotSession.value = session;
  screenshotKind.value = kind;
  screenshotBusy.value = true;
  screenshotError.value = null;
  screenshotImage.value = null;
  try {
    const payload = await api<{ pngBase64: string }>(`/api/admin/minters/${session.id}/screenshot`, {
      method: "POST",
      body: JSON.stringify({ kind }),
    });
    screenshotImage.value = payload.pngBase64;
  } catch (error) {
    screenshotError.value = errorText(error, "截图失败。");
  } finally {
    screenshotBusy.value = false;
  }
}

function closeScreenshot(): void {
  if (screenshotBusy.value) return;
  screenshotSession.value = null;
  screenshotError.value = null;
  screenshotImage.value = null;
}

const settingsDirty = computed(() => {
  const draft = settingsDraft.value;
  const saved = settings.value;
  if (!draft || !saved) return false;
  return (Object.keys(saved) as SettingKey[]).some((key) => draft[key] !== saved[key]);
});

function updateSetting(key: SettingKey, value: number): void {
  if (!settingsDraft.value) return;
  settingsDraft.value = { ...settingsDraft.value, [key]: value };
}

function resetSettings(): void {
  if (settings.value) settingsDraft.value = { ...settings.value };
}

async function saveSettings(): Promise<void> {
  const draft = settingsDraft.value;
  const saved = settings.value;
  if (!draft || !saved) return;
  const patch: Partial<GatewaySettings> = {};
  for (const key of Object.keys(saved) as SettingKey[]) {
    if (draft[key] !== saved[key]) patch[key] = draft[key];
  }
  isSavingSettings.value = true;
  try {
    const payload = await api<{ settings: GatewaySettings; bounds: SettingBounds }>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    settings.value = payload.settings;
    settingsDraft.value = { ...payload.settings };
    settingBounds.value = payload.bounds;
    pushToast("success", "参数已保存。");
  } catch (error) {
    pushToast("error", errorText(error, "保存失败。"));
  } finally {
    isSavingSettings.value = false;
  }
}

const proxyCounts = computed<Record<ProxyStatus, number>>(() => overview.value?.proxies ?? { active: 0, pending: 0, unavailable: 0 });
const proxyGrandTotal = computed(() => {
  const counts = proxyCounts.value;
  return counts.active + counts.pending + counts.unavailable;
});

function selectWorkspace(next: WorkspaceId): void {
  view.value = next;
}

watch(view, (next) => {
  localStorage.setItem(WORKSPACE_STORAGE_KEY, next);
  void refresh();
});
watch(theme, (next) => localStorage.setItem(THEME_STORAGE_KEY, next));
watch(proxyFilter, () => {
  proxyPage.value = 1;
  selectedProxyIds.value = new Set();
  if (view.value === "proxies") void loadProxies();
});
watch([proxyPage, proxyPageSize], () => {
  if (view.value === "proxies") void loadProxies();
});

let refreshTimer: number | undefined;
let clockTimer: number | undefined;

function restartAutoRefresh(): void {
  window.clearInterval(refreshTimer);
  refreshTimer = undefined;
  if (!autoRefresh.value) return;
  refreshTimer = window.setInterval(() => {
    if (!isLoading.value && token.value) void refresh();
  }, 5_000);
}

watch(autoRefresh, restartAutoRefresh);

onMounted(() => {
  clockTimer = window.setInterval(() => (currentTime.value = Date.now()), 1_000);
  restartAutoRefresh();
  if (token.value) void refresh();
});

onUnmounted(() => {
  window.clearInterval(refreshTimer);
  window.clearInterval(clockTimer);
});
</script>

<template>
  <div class="app-shell" :data-theme="theme">
    <section v-if="!token" class="access-page">
      <div class="access-panel">
        <p class="section-kicker">转发服务</p>
        <h1>管理控制台</h1>
        <p class="access-copy">输入 GATEWAY_ADMIN_TOKEN 以管理代理池、凭证对池与授权服务。</p>
        <form class="access-form" @submit.prevent="signIn">
          <label for="admin-token">管理令牌</label>
          <input id="admin-token" v-model="tokenDraft" type="password" autocomplete="current-password" placeholder="GATEWAY_ADMIN_TOKEN" />
          <button class="button button-primary" type="submit">进入控制台</button>
        </form>
        <p v-if="loginError" class="error-line">{{ loginError }}</p>
      </div>
    </section>

    <WorkspaceShell
      v-else
      :workspace="view"
      :loading="isLoading"
      :connected="isConnected"
      :auto-refresh="autoRefresh"
      :theme="theme"
      @select="selectWorkspace"
      @refresh="refresh"
      @sign-out="signOut()"
      @toggle-auto-refresh="autoRefresh = !autoRefresh"
      @change-theme="theme = $event"
    >
      <OverviewWorkspace v-if="view === 'overview'" :overview="overview" />

      <ProxyPoolWorkspace
        v-else-if="view === 'proxies'"
        :proxies="proxies"
        :counts="proxyCounts"
        :total="proxyGrandTotal"
        :filter="proxyFilter"
        :page="proxyPage"
        :page-size="proxyPageSize"
        :page-total="proxyTotal"
        :selected-ids="selectedProxyIds"
        :import-text="importText"
        :import-protocol="importProtocol"
        :import-summary="importSummary"
        :busy-ids="busyProxyIds"
        :importing="isImporting"
        :checking="isChecking"
        :removing="isRemovingProxies"
        :now="currentTime"
        @update:filter="proxyFilter = $event"
        @update:page="proxyPage = $event"
        @update:page-size="proxyPageSize = $event"
        @update:selected-ids="selectedProxyIds = $event"
        @update:import-text="importText = $event"
        @update:import-protocol="importProtocol = $event"
        @import="importProxies"
        @check-scope="checkScope"
        @check-selected="checkSelected"
        @delete-selected="confirmBulkRemoval"
        @check="checkProxy"
        @reactivate="reactivateProxy"
        @delete="pendingProxyRemoval = $event"
      />

      <TicketPoolWorkspace
        v-else-if="view === 'tickets'"
        :tickets="tickets"
        :available="ticketAvailable"
        :total="ticketTotal"
        :target="overview?.tickets.target ?? 0"
        :waiting="overview?.queue.waiting ?? 0"
        :paused="overview?.demand.paused ?? false"
        :ticket-ttl-seconds="settings?.ticketTtlSeconds ?? 0"
        :clearing="isClearingTickets"
        :now="currentTime"
        @clear="pendingTicketClear = true"
      />

      <MintersWorkspace
        v-else-if="view === 'minters'"
        :sessions="minters"
        :online="minterOnline"
        :inflight="minterInflight"
        :busy-ids="busyMinterIds"
        :now="currentTime"
        :screenshot-open="Boolean(screenshotSession)"
        :screenshot-kind="screenshotKind"
        :screenshot-busy="screenshotBusy"
        :screenshot-error="screenshotError"
        :screenshot-image="screenshotImage"
        :screenshot-session="screenshotSession"
        @disconnect="disconnectMinter"
        @screenshot="openScreenshot"
        @close-screenshot="closeScreenshot"
      />

      <SettingsWorkspace
        v-else-if="view === 'settings' && settingsDraft"
        :draft="settingsDraft"
        :bounds="settingBounds"
        :overview="overview"
        :saving="isSavingSettings"
        :dirty="settingsDirty"
        @update="updateSetting"
        @save="saveSettings"
        @reset="resetSettings"
      />
    </WorkspaceShell>

    <AppConfirmDialog
      :open="Boolean(pendingProxyRemoval)"
      title="删除代理"
      :description="`将删除 ${pendingProxyRemoval?.maskedUrl ?? ''} 及其全部凭证，此操作不可撤销。`"
      confirm-label="删除"
      busy-label="删除中…"
      :busy="Boolean(pendingProxyRemoval && busyProxyIds.has(pendingProxyRemoval.id))"
      @update:open="pendingProxyRemoval = $event ? pendingProxyRemoval : null"
      @confirm="confirmProxyRemoval"
    />

    <AppConfirmDialog
      :open="pendingBulkRemoval"
      title="批量删除代理"
      :description="`将删除已勾选的 ${selectedProxyIds.size} 个代理及其全部凭证，此操作不可撤销。`"
      confirm-label="删除"
      busy-label="删除中…"
      :busy="isRemovingProxies"
      @update:open="pendingBulkRemoval = $event"
      @confirm="applyBulkRemoval"
    />

    <AppConfirmDialog
      :open="pendingTicketClear"
      title="清空凭证池"
      description="将删除池内全部凭证对。清空后转发会在补充完成前返回 503。"
      confirm-label="清空"
      busy-label="清空中…"
      :busy="isClearingTickets"
      @update:open="pendingTicketClear = $event"
      @confirm="confirmTicketClear"
    />

    <div class="toast-stack" aria-live="polite">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="{ error: toast.kind === 'error' }">
        <AppIcon :name="toast.kind === 'error' ? 'alert-circle' : 'check-circle'" :size="16" />
        <span class="toast-text">{{ toast.text }}</span>
        <button class="toast-close" type="button" aria-label="关闭提示" @click="dismissToast(toast.id)">×</button>
      </div>
    </div>
  </div>
</template>
