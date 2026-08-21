<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from "vue";

interface RuntimeState {
  inFlight: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError?: string;
  lastUsedAt?: string;
  lastSuccessAt?: string;
}

interface Account {
  id: string;
  label: string;
  emailHint: string;
  enabled: boolean;
  weight: number;
  proxyHint: string | null;
  hasSession: boolean;
  sessionExpiresAt: number | null;
  createdAt: string;
  updatedAt: string;
  runtime: RuntimeState;
}

interface DebugRawBody {
  contentType: "application/json" | "text/event-stream" | "text/plain";
  body: string;
}

interface DebugUpstreamCall {
  sequence: number;
  type: "initial" | "repair" | "continuation";
  round: number;
  attempt: number;
  accountId?: string;
  accountLabel?: string;
  request: DebugRawBody;
  response?: DebugRawBody;
  responseStatus?: number;
  error?: string;
}

interface DebugRecord {
  id: string;
  at: string;
  endpoint: string;
  accountId?: string;
  accountLabel?: string;
  clientRequest: DebugRawBody | Record<string, unknown>;
  clientResponse?: DebugRawBody | Record<string, unknown>;
  upstreamCalls?: DebugUpstreamCall[];
  // Read records written by previous gateway versions as well.
  upstreamRequest?: Record<string, unknown>;
  upstreamResponse?: Record<string, unknown>;
  toolCallAdapter?: {
    toolCallExpected: "auto" | "required" | "forced";
    initialParseSucceeded: boolean;
    finalParseSucceeded: boolean;
    initialParseRepaired?: boolean;
    finalParseRepaired?: boolean;
    initialOutcome: "tool_calls" | "final" | "invalid";
    finalOutcome: "tool_calls" | "final" | "invalid";
    repairAttempts: number;
    maxRepairAttempts: number;
    errors: string[];
  };
  status: number;
  error?: string;
}

interface DebugUpstreamCallSummary {
  sequence: number;
  type: "initial" | "repair" | "continuation";
  round: number;
  attempt: number;
  accountId?: string;
  accountLabel?: string;
  responseStatus?: number;
  error?: string;
}

/** Lightweight list metadata; full bodies load on demand per record. */
interface DebugRecordSummary {
  id: string;
  at: string;
  endpoint: string;
  status: number;
  accountId?: string;
  accountLabel?: string;
  error?: string;
  preview: string;
  upstreamCalls?: DebugUpstreamCallSummary[];
  legacyUpstream?: boolean;
  toolCall?: {
    forces: boolean;
    initialOutcome: "tool_calls" | "final" | "invalid";
    finalOutcome: "tool_calls" | "final" | "invalid";
  };
}

interface ApiPayload {
  accounts?: Account[];
  settings?: { recordMessages: boolean };
  config?: {
    adminTokenConfigured: boolean;
    clientApiKeyRequired: boolean;
    defaultModel: string;
  };
  records?: DebugRecordSummary[];
  record?: DebugRecord;
  account?: Account | null;
}

type JsonRecord = Record<string, unknown>;

interface DisplayToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface DisplayMessage {
  role: string;
  roleLabel: string;
  content: string;
  toolCalls: DisplayToolCall[];
}

interface DisplayField {
  label: string;
  value: string;
}

const tokenStorageKey = "neuralwatt-admin-token";
const token = ref(typeof window === "undefined" ? "" : sessionStorage.getItem(tokenStorageKey) ?? "");
const tokenDraft = ref(token.value);
const view = ref<"accounts" | "records">("accounts");
// shallowRef: record/account payloads are large and immutable; avoid deep reactivity.
const accounts = shallowRef<Account[]>([]);
const records = shallowRef<DebugRecordSummary[]>([]);
const settings = reactive({ recordMessages: false });
const config = reactive({
  adminTokenConfigured: false,
  clientApiKeyRequired: false,
  defaultModel: "",
});
const newAccount = reactive({ label: "", email: "", password: "", weight: 1, proxy: "" });
const isLoading = ref(false);
const isSaving = ref(false);
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

// ---- Modals & per-account busy state ----
const showAddAccount = ref(false);
const proxyEditor = ref<{ account: Account; value: string } | null>(null);
const pendingRemoval = ref<Account | null>(null);
const showClearConfirm = ref(false);
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
const recordQuery = ref("");
const recordFilter = ref<"all" | "success" | "failed">("all");

// ---- Auto refresh ----
const autoRefresh = ref(false);
let autoRefreshTimer: number | undefined;

// Long message collapse state. Keys are `request-${index}` / `response-${index}`
// and are reset whenever the selected trace changes.
const COLLAPSE_MAX_HEIGHT = 240;
const expandedMessageKeys = ref(new Set<string>());
const overflowMessageKeys = ref(new Set<string>());
const messageContentEls = new Map<string, HTMLElement>();

const enabledCount = computed(() => accounts.value.filter((account) => account.enabled).length);
const activeSessions = computed(() => accounts.value.filter((account) => account.hasSession).length);
const cooldownCount = computed(() => accounts.value.filter((account) => account.runtime.cooldownUntil > Date.now()).length);

const filteredAccounts = computed(() => {
  const query = accountQuery.value.trim().toLowerCase();
  if (!query) return accounts.value;
  return accounts.value.filter((account) =>
    account.label.toLowerCase().includes(query)
    || account.emailHint.toLowerCase().includes(query)
    || (account.proxyHint ?? "").toLowerCase().includes(query));
});

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
}

function signOut() {
  token.value = "";
  tokenDraft.value = "";
  sessionStorage.removeItem(tokenStorageKey);
  accounts.value = [];
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
  pendingRemoval.value = null;
  showClearConfirm.value = false;
  autoRefresh.value = false;
}

async function loadDashboard(options?: { silent?: boolean }) {
  if (!token.value) {
    return;
  }
  if (!options?.silent) isLoading.value = true;
  try {
    const payload = await api("/api/admin/status");
    accounts.value = payload.accounts ?? [];
    Object.assign(settings, payload.settings ?? {});
    Object.assign(config, payload.config ?? {});
    if (view.value === "records") {
      await loadRecords();
    }
  } catch (error) {
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
    if (!options?.silent) isLoading.value = false;
  }
}

async function loadRecords() {
  const payload = await api("/api/admin/records?limit=100");
  records.value = payload.records ?? [];
  Object.assign(settings, payload.settings ?? {});
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

async function selectView(next: "accounts" | "records") {
  view.value = next;
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
    showAddAccount.value = false;
    pushToast("success", "账号验证成功并已添加");
    await loadDashboard({ silent: true });
  } catch (error) {
    pushToast("error", errorText(error, "无法添加账号。"));
  } finally {
    isSaving.value = false;
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
    pushToast("success", value === "" ? `${editor.account.label} 的代理已清除` : `${editor.account.label} 的代理已更新，会话将重新登录`);
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
    accounts.value = accounts.value.filter((item) => item.id !== account.id);
    pendingRemoval.value = null;
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
    settings.recordMessages = payload.settings?.recordMessages ?? value;
    pushToast("success", value ? "已开启消息记录" : "已关闭消息记录");
  } catch (error) {
    pushToast("error", errorText(error, "无法更新消息记录设置。"));
  }
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
  const index = accounts.value.findIndex((account) => account.id === next.id);
  if (index === -1) {
    accounts.value = [...accounts.value, next];
  } else {
    accounts.value = accounts.value.map((account, i) => (i === index ? next : account));
  }
}

function formatDate(value: string | number | null | undefined): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

type BadgeTone = "good" | "warn" | "bad" | "muted";

function sessionBadge(account: Account): { text: string; tone: BadgeTone } {
  if (!account.hasSession) {
    return { text: "未登录", tone: "muted" };
  }
  if (account.sessionExpiresAt && account.sessionExpiresAt < Date.now()) {
    return { text: "已过期", tone: "bad" };
  }
  return { text: "会话有效", tone: "good" };
}

function runtimeBadge(account: Account): { text: string; tone: BadgeTone } {
  if (account.runtime.cooldownUntil > Date.now()) {
    return { text: "冷却中", tone: "warn" };
  }
  if (!account.enabled) {
    return { text: "已禁用", tone: "muted" };
  }
  if (account.runtime.inFlight > 0) {
    return { text: `${account.runtime.inFlight} 个请求处理中`, tone: "good" };
  }
  return { text: "就绪", tone: "good" };
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

function toolModeLabel(value: string): string {
  return ({ auto: "自动", required: "必须调用", forced: "指定函数" } as Record<string, string>)[value] ?? value;
}

function toolOutcomeLabel(value: string): string {
  return ({ tool_calls: "工具调用", final: "最终回复", invalid: "解析失败" } as Record<string, string>)[value] ?? value;
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
  return value.split("@@REPAIR_REASONING@@").join(" ").split("@@FINAL_REPLY@@").join("").replace(/\s+/g, " ").trim();
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

/** Collect messages from a body, concatenating streaming chunks into one box per kind. */
function collectBodyMessages(value: DebugRawBody | JsonRecord | undefined, stripMarkers: boolean): DisplayMessage[] {
  const values = parsedBodyValues(value);
  if (values.some(isStreamingChunk)) {
    const aggregated = aggregateStreamingMessages(values, stripMarkers);
    if (aggregated.length > 0) return aggregated;
  }
  return values.flatMap(collectMessages);
}

function collectMessages(value: unknown): DisplayMessage[] {
  const source = asObject(value);
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
  max_tokens: "最大令牌数",
  tool_choice: "工具选择",
  parallel_tool_calls: "并行工具调用",
  response_format: "响应格式",
  object: "对象类型",
  id: "请求 ID",
  created: "创建时间",
  finish_reason: "结束原因",
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

interface ConversationTrace {
  key: string;
  record: DebugRecord;
  direction: "client" | "upstream";
  title: string;
  subtitle: string;
  request: DebugRawBody | JsonRecord;
  response?: DebugRawBody | JsonRecord;
  status: number;
  error?: string;
}

interface BodyPresentation {
  contentType: string;
  raw: string;
  fields: DisplayField[];
  messages: DisplayMessage[];
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
  const streaming = values.some(isStreamingChunk);
  const messages = collectBodyMessages(value, options?.stripMarkers ?? true);
  const raw = rawBodyText(value);
  const fields = values.flatMap(recordFields);
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

/** Bubble alignment: model/system/tool calls on the left, user input on the right. */
function messageAlign(role: string): "left" | "right" {
  return ["user", "tool"].includes(role) ? "right" : "left";
}

function setMessageContentEl(key: string, el: unknown): void {
  if (el instanceof HTMLElement) {
    messageContentEls.set(key, el);
    requestAnimationFrame(() => measureMessageContent(key));
  } else {
    messageContentEls.delete(key);
  }
}

function measureMessageContent(key: string): void {
  const el = messageContentEls.get(key);
  if (!el) return;
  if (el.scrollHeight > COLLAPSE_MAX_HEIGHT + 2) {
    overflowMessageKeys.value.add(key);
  } else {
    overflowMessageKeys.value.delete(key);
  }
}

function toggleMessageExpanded(key: string): void {
  const next = new Set(expandedMessageKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedMessageKeys.value = next;
}

function isMessageExpanded(key: string): boolean {
  return expandedMessageKeys.value.has(key);
}

function traceRequest(trace: ConversationTrace): BodyPresentation {
  return presentBody(trace.request, { stripMarkers: trace.direction === "client" });
}

function traceResponse(trace: ConversationTrace): BodyPresentation | undefined {
  return trace.response ? presentBody(trace.response, { stripMarkers: trace.direction === "client" }) : undefined;
}

function traceRawKey(trace: ConversationTrace): string {
  return `raw:${trace.key}`;
}

function traceRecordLabel(trace: ConversationTrace): string {
  return `${formatDate(trace.record.at)} · ${trace.record.endpoint}`;
}

/** Compact timestamp for the sidebar: HH:MM:SS today, MM-DD HH:MM otherwise. */
function compactTime(value: string): string {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

// ---- Prev / next record navigation ----
const detailEl = ref<HTMLElement | null>(null);
const selectedRecordIndex = computed(() => {
  if (!selectedRecordId.value) return -1;
  return filteredRecords.value.findIndex((record) => record.id === selectedRecordId.value);
});

function gotoRecord(offset: number): void {
  const next = filteredRecords.value[selectedRecordIndex.value + offset] ?? (selectedRecordIndex.value === -1 ? filteredRecords.value[0] : undefined);
  if (!next) return;
  void selectRecord(next.id);
  void nextTick(() => {
    detailEl.value?.scrollIntoView({ block: "start" });
    document.querySelector(".trace-group.active")?.scrollIntoView({ block: "nearest" });
  });
}

// Sidebar rows are precomputed once per records/filter change so rendering
// never rebuilds upstream items per item per render.
interface SidebarUpstreamItem {
  key: string;
  title: string;
  subtitle: string;
  status: number;
  failed: boolean;
}

interface SidebarItem {
  record: DebugRecordSummary;
  upstream: SidebarUpstreamItem[];
}

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

watch(selectedTraceKey, () => {
  expandedMessageKeys.value = new Set();
  overflowMessageKeys.value = new Set();
  messageContentEls.clear();
});

watch(autoRefresh, (enabled) => {
  window.clearInterval(autoRefreshTimer);
  autoRefreshTimer = undefined;
  if (enabled) {
    autoRefreshTimer = window.setInterval(() => {
      void loadDashboard({ silent: true });
    }, 30_000);
  }
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    if (proxyEditor.value) proxyEditor.value = null;
    else if (pendingRemoval.value) pendingRemoval.value = null;
    else if (showClearConfirm.value) showClearConfirm.value = false;
    else if (showAddAccount.value) showAddAccount.value = false;
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (view.value !== "records" || !token.value) return;
  if (showAddAccount.value || proxyEditor.value || pendingRemoval.value || showClearConfirm.value) return;
  const target = event.target as HTMLElement | null;
  if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
  event.preventDefault();
  gotoRecord(event.key === "ArrowLeft" ? -1 : 1);
}

function onWindowResize(): void {
  for (const key of [...messageContentEls.keys()]) {
    measureMessageContent(key);
  }
}

onMounted(() => {
  if (token.value) {
    void loadDashboard();
  }
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
});

onUnmounted(() => {
  window.clearInterval(autoRefreshTimer);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
});
</script>
<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="wordmark">
        <span class="wordmark-mark">NW</span>
        <span>NeuralWatt 网关</span>
      </div>
      <div v-if="token" class="topbar-actions">
        <span class="connection-dot" :class="{ busy: isLoading }"></span>
        <span class="topbar-status">{{ isLoading ? "刷新中" : "已连接" }}</span>
        <button class="button button-quiet" type="button" :disabled="isLoading" @click="loadDashboard()">刷新</button>
        <button class="button button-quiet" type="button" @click="signOut">退出登录</button>
      </div>
    </header>

    <main v-if="!token" class="access-page">
      <section class="access-panel" aria-labelledby="access-title">
        <p class="section-kicker">管理员入口</p>
        <h1 id="access-title">网关控制台</h1>
        <p class="access-copy">请输入服务端管理员令牌继续。</p>
        <form class="access-form" @submit.prevent="useToken">
          <label for="admin-token">管理员令牌</label>
          <input id="admin-token" v-model="tokenDraft" type="password" autocomplete="off" spellcheck="false" />
          <button class="button button-primary" type="submit">进入控制台</button>
        </form>
        <p v-if="loginError" class="error-line" role="alert">{{ loginError }}</p>
      </section>
    </main>

    <main v-else class="dashboard">
      <section class="dashboard-heading">
        <div>
          <p class="section-kicker">运行概览</p>
          <h1>网关控制台</h1>
        </div>
        <label class="auto-refresh" for="auto-refresh-toggle">
          <button id="auto-refresh-toggle" class="switch" :class="{ on: autoRefresh }" type="button" :aria-pressed="autoRefresh" @click="autoRefresh = !autoRefresh">
            <span></span>
          </button>
          自动刷新（30 秒）
        </label>
      </section>

      <section class="metric-grid" aria-label="网关状态">
        <article class="metric">
          <span class="metric-label">已启用账号</span>
          <strong>{{ enabledCount }}<small>/{{ accounts.length }}</small></strong>
        </article>
        <article class="metric">
          <span class="metric-label">有效会话</span>
          <strong>{{ activeSessions }}</strong>
        </article>
        <article class="metric">
          <span class="metric-label">冷却账号</span>
          <strong>{{ cooldownCount }}</strong>
        </article>
        <article class="metric metric-wide">
          <span class="metric-label">默认模型</span>
          <strong class="metric-model">{{ config.defaultModel || "-" }}</strong>
        </article>
      </section>

      <nav class="view-tabs" aria-label="网关视图">
        <button type="button" :class="{ active: view === 'accounts' }" @click="selectView('accounts')">账号管理</button>
        <button type="button" :class="{ active: view === 'records' }" @click="selectView('records')">聊天记录</button>
      </nav>

      <template v-if="view === 'accounts'">
        <section class="panel accounts-panel">
          <div class="panel-heading">
            <div>
              <p class="section-kicker">连接池</p>
              <h2>账号管理</h2>
              <p class="panel-sub">粘性会话 · 加权负载 · {{ enabledCount }}/{{ accounts.length }} 已启用</p>
            </div>
            <div class="panel-actions">
              <input v-model="accountQuery" class="search-input" type="search" placeholder="搜索账号、邮箱或代理…" aria-label="搜索账号" />
              <button class="button button-primary" type="button" @click="showAddAccount = true">+ 添加账号</button>
            </div>
          </div>

          <div v-if="accounts.length === 0" class="empty-state">
            <p>尚未配置账号。</p>
            <button class="button button-primary" type="button" @click="showAddAccount = true">添加第一个账号</button>
          </div>
          <div v-else-if="filteredAccounts.length === 0" class="empty-state">
            <p>没有匹配「{{ accountQuery }}」的账号。</p>
          </div>
          <div v-else class="account-cards">
            <article v-for="account in filteredAccounts" :key="account.id" class="account-card" :class="{ 'card-disabled': !account.enabled }">
              <header class="account-card-head">
                <div class="account-identity">
                  <strong>{{ account.label }}</strong>
                  <span class="muted">{{ account.emailHint }}</span>
                </div>
                <span class="badge" :class="runtimeBadge(account).tone">{{ runtimeBadge(account).text }}</span>
              </header>
              <dl class="account-facts">
                <div>
                  <dt>会话</dt>
                  <dd>
                    <span class="badge" :class="sessionBadge(account).tone">{{ sessionBadge(account).text }}</span>
                    <span v-if="account.hasSession && account.sessionExpiresAt" class="muted">至 {{ formatDate(account.sessionExpiresAt) }}</span>
                  </dd>
                </div>
                <div>
                  <dt>权重</dt>
                  <dd>{{ account.weight }}</dd>
                </div>
                <div>
                  <dt>代理</dt>
                  <dd class="mono">{{ account.proxyHint ?? "直连" }}</dd>
                </div>
                <div>
                  <dt>更新</dt>
                  <dd>{{ formatDate(account.updatedAt) }}</dd>
                </div>
              </dl>
              <p v-if="account.runtime.lastError" class="account-error" :title="account.runtime.lastError">{{ account.runtime.lastError }}</p>
              <footer class="account-actions">
                <button class="text-button" type="button" :disabled="isAccountBusy(account.id)" @click="verifyAccount(account)">验证</button>
                <button class="text-button" type="button" :disabled="isAccountBusy(account.id)" @click="openProxyEditor(account)">代理</button>
                <button class="text-button" type="button" :disabled="isAccountBusy(account.id)" @click="toggleAccount(account)">{{ account.enabled ? "禁用" : "启用" }}</button>
                <button class="text-button danger" type="button" :disabled="isAccountBusy(account.id)" @click="askRemoveAccount(account)">移除</button>
              </footer>
            </article>
          </div>
        </section>
      </template>


      <template v-else>
        <section class="panel records-panel">
          <div class="panel-heading records-heading">
            <div>
              <p class="section-kicker">调试记录</p>
              <h2>请求对话</h2>
            </div>
            <div class="record-control">
              <label class="switch-label" for="record-toggle">记录消息</label>
              <button id="record-toggle" class="switch" :class="{ on: settings.recordMessages }" type="button" :aria-pressed="settings.recordMessages" @click="setRecording(!settings.recordMessages)">
                <span></span>
              </button>
              <button class="button button-quiet" type="button" @click="loadRecords">刷新</button>
              <button class="button button-danger" type="button" :disabled="records.length === 0 || isClearingRecords" @click="askClearRecords">清空全部</button>
            </div>
          </div>
          <div class="records-toolbar">
            <input v-model="recordQuery" class="search-input" type="search" placeholder="按端点或账号搜索…" aria-label="搜索记录" />
            <div class="filter-chips" role="group" aria-label="按状态过滤">
              <button type="button" :class="{ active: recordFilter === 'all' }" @click="recordFilter = 'all'">全部 {{ records.length }}</button>
              <button type="button" :class="{ active: recordFilter === 'success' }" @click="recordFilter = 'success'">成功 {{ records.length - failedRecordCount }}</button>
              <button type="button" :class="{ active: recordFilter === 'failed' }" @click="recordFilter = 'failed'">失败 {{ failedRecordCount }}</button>
            </div>
          </div>
          <p class="records-meta">
            {{ settings.recordMessages ? "消息记录已开启" : "消息记录已关闭" }} · {{ records.length }} 个客户端请求 · {{ upstreamCallCount }} 次上游调用
            <template v-if="toolFirstPassRate !== null"> · 工具 JSON 首次解析成功率 {{ toolFirstPassRate }}%（{{ toolAdapterRecords.length }} 轮）</template>
          </p>
          <div v-if="filteredRecords.length === 0" class="empty-state">
            <p>{{ records.length === 0 ? "暂无聊天记录。" : "没有匹配当前过滤条件的记录。" }}</p>
          </div>
          <div v-else class="conversation-workbench">
            <aside class="trace-sidebar" aria-label="请求发送列表">
              <section
                v-for="item in sidebarItems"
                :key="item.record.id"
                v-memo="[item.record.id === selectedRecordId, item.upstream.some((child) => child.key === selectedTraceKey)]"
                class="trace-group"
                :class="{ active: selectedRecordId === item.record.id }"
              >
                <button class="trace-record" type="button" @click="selectRecord(item.record.id)">
                  <span class="trace-record-top">
                    <span class="status-chip" :class="item.record.status < 400 ? 'ok' : 'err'">{{ item.record.status }}</span>
                    <span class="trace-endpoint">{{ item.record.endpoint }}</span>
                    <time class="trace-time">{{ compactTime(item.record.at) }}</time>
                  </span>
                  <span class="trace-preview">{{ item.record.preview }}</span>
                  <span class="trace-record-sub">
                    {{ item.record.accountLabel || "未分配账号" }}<template v-if="item.upstream.length"> · {{ item.upstream.length }} 次上游调用</template>
                  </span>
                </button>
                <div v-if="item.upstream.length" class="trace-children">
                  <button
                    v-for="child in item.upstream"
                    :key="child.key"
                    class="trace-child"
                    :class="{ active: selectedTraceKey === child.key, failed: child.failed }"
                    type="button"
                    @click="selectRecord(item.record.id, child.key)"
                  >
                    <span class="trace-child-title">{{ child.title }}</span>
                    <span class="trace-child-sub">{{ child.subtitle }} · HTTP {{ child.status }}</span>
                  </button>
                </div>
              </section>
            </aside>

            <section v-if="selectedTrace" ref="detailEl" class="conversation-detail" :key="selectedTrace.key">
              <header class="conversation-header">
                <div class="conversation-heading">
                  <div class="conversation-title-row">
                    <span class="status-chip" :class="selectedTrace.status < 400 ? 'ok' : 'err'">{{ selectedTrace.status }}</span>
                    <h3>{{ selectedTrace.title }}</h3>
                    <span class="conversation-dir">{{ selectedTrace.direction === "client" ? "客户端会话" : "上游调用" }}</span>
                  </div>
                  <p class="conversation-meta">{{ traceRecordLabel(selectedTrace) }} · {{ selectedTrace.subtitle }}</p>
                </div>
                <div class="conversation-actions">
                  <div class="record-nav">
                    <button type="button" aria-label="上一条记录" :disabled="selectedRecordIndex <= 0" @click="gotoRecord(-1)">←</button>
                    <button type="button" aria-label="下一条记录" :disabled="selectedRecordIndex === -1 || selectedRecordIndex >= filteredRecords.length - 1" @click="gotoRecord(1)">→</button>
                  </div>
                  <button class="button button-quiet" type="button" @click="rawTraceKey = rawTraceKey === traceRawKey(selectedTrace) ? null : traceRawKey(selectedTrace)">
                    {{ rawTraceKey === traceRawKey(selectedTrace) ? "查看对话" : "原始数据" }}
                  </button>
                </div>
              </header>

              <div v-if="rawTraceKey === traceRawKey(selectedTrace)" class="raw-trace">
                <section>
                  <h4>请求正文 · {{ selectedRequest?.contentType }}</h4>
                  <pre>{{ selectedRequest?.raw }}</pre>
                </section>
                <section v-if="selectedResponse">
                  <h4>响应正文 · {{ selectedResponse?.contentType }}</h4>
                  <pre>{{ selectedResponse?.raw }}</pre>
                </section>
              </div>

              <div v-else class="chat-flow">
                <article
                  v-for="(message, index) in selectedRequest?.messages ?? []"
                  :key="`request-${index}`"
                  class="chat-msg"
                  :class="[messageAlign(message.role) === 'right' ? 'right' : 'left', { thinking: message.roleLabel === '思考' }]"
                >
                  <div class="chat-role">{{ message.roleLabel }}</div>
                  <div class="chat-bubble">
                    <div class="message-collapse" :class="{ expanded: isMessageExpanded(`request-${index}`), 'has-overflow': overflowMessageKeys.has(`request-${index}`) }" :ref="(el) => setMessageContentEl(`request-${index}`, el)">
                      <p v-if="message.content" class="message-content">{{ message.content }}</p>
                      <div v-for="call in message.toolCalls" :key="call.id" class="tool-call-item">
                        <span class="tool-call-name">工具：{{ call.name }}</span>
                        <code>{{ call.arguments }}</code>
                      </div>
                    </div>
                    <button v-if="overflowMessageKeys.has(`request-${index}`)" class="expand-toggle" type="button" @click="toggleMessageExpanded(`request-${index}`)">
                      {{ isMessageExpanded(`request-${index}`) ? "收起" : "展开全部" }}
                    </button>
                  </div>
                </article>

                <div class="chat-divider"><span>{{ selectedTrace.direction === "client" ? "客户端响应" : "上游响应" }} · HTTP {{ selectedTrace.status }}</span></div>

                <template v-if="selectedResponse">
                  <article
                    v-for="(message, index) in selectedResponse?.messages"
                    :key="`response-${index}`"
                    class="chat-msg"
                    :class="[messageAlign(message.role) === 'right' ? 'right' : 'left', { thinking: message.roleLabel === '思考' }]"
                  >
                    <div class="chat-role">{{ message.roleLabel }}</div>
                    <div class="chat-bubble">
                      <div class="message-collapse" :class="{ expanded: isMessageExpanded(`response-${index}`), 'has-overflow': overflowMessageKeys.has(`response-${index}`) }" :ref="(el) => setMessageContentEl(`response-${index}`, el)">
                        <p v-if="message.content" class="message-content">{{ message.content }}</p>
                        <div v-for="call in message.toolCalls" :key="call.id" class="tool-call-item">
                          <span class="tool-call-name">工具：{{ call.name }}</span>
                          <code>{{ call.arguments }}</code>
                        </div>
                      </div>
                      <button v-if="overflowMessageKeys.has(`response-${index}`)" class="expand-toggle" type="button" @click="toggleMessageExpanded(`response-${index}`)">
                        {{ isMessageExpanded(`response-${index}`) ? "收起" : "展开全部" }}
                      </button>
                    </div>
                  </article>
                  <p v-if="!selectedResponse?.messages.length" class="parsed-empty">响应无消息内容。</p>
                </template>
                <p v-else class="parsed-empty">尚未收到响应正文。</p>

                <p v-if="selectedTrace.error" class="trace-error">{{ selectedTrace.error }}</p>

                <details v-if="selectedRequest?.fields.length" class="fold-section">
                  <summary>请求参数 <span class="fold-count">{{ selectedRequest?.fields.length }}</span></summary>
                  <dl class="record-fields">
                    <template v-for="(field, index) in selectedRequest?.fields" :key="`request-field-${index}`">
                      <dt>{{ field.label }}</dt><dd>{{ field.value }}</dd>
                    </template>
                  </dl>
                </details>

                <details v-if="selectedResponse?.fields.length" class="fold-section">
                  <summary>响应元数据 <span class="fold-count">{{ selectedResponse?.fields.length }}</span></summary>
                  <dl class="record-fields">
                    <template v-for="(field, index) in selectedResponse?.fields" :key="`response-field-${index}`">
                      <dt>{{ field.label }}</dt><dd>{{ field.value }}</dd>
                    </template>
                  </dl>
                </details>

                <details v-if="selectedTrace.record.toolCallAdapter" class="fold-section">
                  <summary>
                    工具调用转换
                    <span class="fold-count">{{ toolOutcomeLabel(selectedTrace.record.toolCallAdapter.finalOutcome) }}</span>
                    <span v-if="selectedTrace.record.toolCallAdapter.errors.length" class="fold-count fold-count-err">{{ selectedTrace.record.toolCallAdapter.errors.length }} 个错误</span>
                  </summary>
                  <dl class="record-fields">
                    <dt>预期模式</dt><dd>{{ toolModeLabel(selectedTrace.record.toolCallAdapter.toolCallExpected) }}</dd>
                    <dt>首次结果</dt><dd>{{ toolOutcomeLabel(selectedTrace.record.toolCallAdapter.initialOutcome) }}</dd>
                    <dt>最终结果</dt><dd>{{ toolOutcomeLabel(selectedTrace.record.toolCallAdapter.finalOutcome) }}</dd>
                    <dt>修复次数</dt><dd>{{ selectedTrace.record.toolCallAdapter.repairAttempts }} / {{ selectedTrace.record.toolCallAdapter.maxRepairAttempts }}</dd>
                    <dt>首次解析</dt><dd>{{ selectedTrace.record.toolCallAdapter.initialParseSucceeded ? (selectedTrace.record.toolCallAdapter.initialParseRepaired ? "成功（自动修复）" : "成功") : "失败" }}</dd>
                    <dt>最终解析</dt><dd>{{ selectedTrace.record.toolCallAdapter.finalParseSucceeded ? (selectedTrace.record.toolCallAdapter.finalParseRepaired ? "成功（自动修复）" : "成功") : "失败" }}</dd>
                  </dl>
                  <ul v-if="selectedTrace.record.toolCallAdapter.errors.length" class="error-list">
                    <li v-for="error in selectedTrace.record.toolCallAdapter.errors" :key="error">{{ error }}</li>
                  </ul>
                </details>
              </div>
            </section>

            <section v-else-if="isLoadingRecord" class="conversation-detail">
              <p class="parsed-empty">正在加载记录详情…</p>
            </section>
          </div>
        </section>
      </template>
    </main>

    <div v-if="showAddAccount" class="modal-backdrop" @click.self="showAddAccount = false">
      <form class="modal" @submit.prevent="addAccount">
        <header class="modal-head">
          <h2>添加账号</h2>
          <button class="modal-close" type="button" aria-label="关闭" @click="showAddAccount = false">×</button>
        </header>
        <p class="modal-note">保存时将验证门户登录，验证成功后加入连接池。</p>
        <div class="modal-body">
          <label for="account-label">账号名称</label>
          <input id="account-label" v-model="newAccount.label" type="text" maxlength="120" placeholder="主账号 Kimi" />
          <label for="account-email">门户邮箱</label>
          <input id="account-email" v-model="newAccount.email" type="email" maxlength="320" autocomplete="off" required />
          <label for="account-password">门户密码</label>
          <input id="account-password" v-model="newAccount.password" type="password" maxlength="4096" autocomplete="new-password" required />
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
          <button class="button button-quiet" type="button" @click="showAddAccount = false">取消</button>
          <button class="button button-primary" type="submit" :disabled="isSaving">{{ isSaving ? "验证中…" : "验证并添加" }}</button>
        </footer>
      </form>
    </div>

    <div v-if="proxyEditor" class="modal-backdrop" @click.self="proxyEditor = null">
      <form class="modal" @submit.prevent="saveProxy">
        <header class="modal-head">
          <h2>设置出口代理</h2>
          <button class="modal-close" type="button" aria-label="关闭" @click="proxyEditor = null">×</button>
        </header>
        <p class="modal-note">账号「{{ proxyEditor.account.label }}」 · 当前：{{ proxyEditor.account.proxyHint ?? "直连" }}</p>
        <div class="modal-body">
          <label for="proxy-input">代理地址</label>
          <input id="proxy-input" v-model="proxyEditor.value" type="text" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="http://host:8080 或 socks5://user:pass@host:1080" />
          <p class="field-hint">支持 http / https / socks4 / socks5，可带认证。留空并保存将清除代理；修改后会话将重新登录。</p>
        </div>
        <footer class="modal-foot">
          <button class="button button-quiet" type="button" @click="proxyEditor = null">取消</button>
          <button class="button button-primary" type="submit" :disabled="isAccountBusy(proxyEditor.account.id)">保存</button>
        </footer>
      </form>
    </div>

    <div v-if="pendingRemoval" class="modal-backdrop" @click.self="pendingRemoval = null">
      <div class="modal modal-confirm" role="alertdialog" aria-labelledby="remove-title">
        <header class="modal-head">
          <h2 id="remove-title">移除账号</h2>
        </header>
        <p class="confirm-text">确定移除账号「{{ pendingRemoval.label }}」吗？该账号的会话将被删除，此操作不可撤销。</p>
        <footer class="modal-foot">
          <button class="button button-quiet" type="button" @click="pendingRemoval = null">取消</button>
          <button class="button button-danger-solid" type="button" :disabled="isAccountBusy(pendingRemoval.id)" @click="confirmRemoveAccount">移除</button>
        </footer>
      </div>
    </div>

    <div v-if="showClearConfirm" class="modal-backdrop" @click.self="showClearConfirm = false">
      <div class="modal modal-confirm" role="alertdialog" aria-labelledby="clear-title">
        <header class="modal-head">
          <h2 id="clear-title">清空聊天记录</h2>
        </header>
        <p class="confirm-text">确定清空全部 {{ records.length }} 条聊天记录吗？此操作不可撤销。</p>
        <footer class="modal-foot">
          <button class="button button-quiet" type="button" @click="showClearConfirm = false">取消</button>
          <button class="button button-danger-solid" type="button" :disabled="isClearingRecords" @click="confirmClearRecords">{{ isClearingRecords ? "清空中…" : "清空全部" }}</button>
        </footer>
      </div>
    </div>

    <div class="toast-stack" aria-live="polite">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind">
        <span class="toast-text">{{ toast.text }}</span>
        <button class="toast-close" type="button" aria-label="关闭通知" @click="dismissToast(toast.id)">×</button>
      </div>
    </div>
  </div>
</template>
