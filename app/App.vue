<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";

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
    initialOutcome: "tool_calls" | "final" | "invalid";
    finalOutcome: "tool_calls" | "final" | "invalid";
    repairAttempts: number;
    maxRepairAttempts: number;
    errors: string[];
  };
  status: number;
  error?: string;
}

interface ApiPayload {
  accounts?: Account[];
  settings?: { recordMessages: boolean };
  config?: {
    adminTokenConfigured: boolean;
    clientApiKeyRequired: boolean;
    defaultModel: string;
  };
  records?: DebugRecord[];
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

interface ParsedSection {
  key: string;
  title: string;
  fields: DisplayField[];
  messages: DisplayMessage[];
}

const tokenStorageKey = "neuralwatt-admin-token";
const token = ref(typeof window === "undefined" ? "" : sessionStorage.getItem(tokenStorageKey) ?? "");
const tokenDraft = ref(token.value);
const view = ref<"accounts" | "records">("accounts");
const accounts = ref<Account[]>([]);
const records = ref<DebugRecord[]>([]);
const settings = reactive({ recordMessages: false });
const config = reactive({
  adminTokenConfigured: false,
  clientApiKeyRequired: false,
  defaultModel: "",
});
const newAccount = reactive({ label: "", email: "", password: "", weight: 1 });
const isLoading = ref(false);
const isSaving = ref(false);
const isClearingRecords = ref(false);
const selectedTraceKey = ref<string | null>(null);
const rawTraceKey = ref<string | null>(null);
const errorMessage = ref("");
const notice = ref("");

const enabledCount = computed(() => accounts.value.filter((account) => account.enabled).length);
const activeSessions = computed(() => accounts.value.filter((account) => account.hasSession).length);
const cooldownCount = computed(() => accounts.value.filter((account) => account.runtime.cooldownUntil > Date.now()).length);
function recordRequestObject(record: DebugRecord): JsonRecord | null {
  return parsedBodyValues(record.clientRequest)
    .map(asObject)
    .find((value): value is JsonRecord => Boolean(value)) ?? null;
}

function forcesTool(record: DebugRecord): boolean {
  const choice = recordRequestObject(record)?.tool_choice;
  return choice === "required" || (choice && typeof choice === "object" && (choice as { type?: unknown }).type === "function");
}

function isToolIntent(record: DebugRecord): boolean {
  const trace = record.toolCallAdapter;
  if (!trace) return false;
  return forcesTool(record)
    || trace.initialOutcome === "invalid"
    || trace.finalOutcome === "tool_calls"
    || trace.finalOutcome === "invalid";
}

const toolAdapterRecords = computed(() => records.value.filter((record) =>
  isToolIntent(record)));
const toolFirstPassRate = computed(() => {
  if (toolAdapterRecords.value.length === 0) return null;
  const successes = toolAdapterRecords.value.filter((record) => record.toolCallAdapter?.initialOutcome === "tool_calls").length;
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
    errorMessage.value = "请输入管理员令牌。";
    return;
  }
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
  errorMessage.value = "";
}

async function loadDashboard() {
  if (!token.value) {
    return;
  }
  isLoading.value = true;
  errorMessage.value = "";
  try {
    const payload = await api("/api/admin/status");
    accounts.value = payload.accounts ?? [];
    Object.assign(settings, payload.settings ?? {});
    Object.assign(config, payload.config ?? {});
    if (view.value === "records") {
      await loadRecords();
    }
    notice.value = "刚刚更新";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "无法加载控制台。";
    if (errorMessage.value.includes("Invalid admin token") || errorMessage.value.includes("管理员令牌无效")) {
      token.value = "";
      tokenDraft.value = "";
      sessionStorage.removeItem(tokenStorageKey);
    }
  } finally {
    isLoading.value = false;
  }
}

async function loadRecords() {
  const payload = await api("/api/admin/records?limit=100");
  records.value = payload.records ?? [];
  Object.assign(settings, payload.settings ?? {});
  const traces = records.value.flatMap(recordTraces);
  if (!traces.some((trace) => trace.key === selectedTraceKey.value)) {
    selectedTraceKey.value = traces[0]?.key ?? null;
    rawTraceKey.value = null;
  }
}

async function selectView(next: "accounts" | "records") {
  view.value = next;
  errorMessage.value = "";
  if (next === "records") {
    try {
      await loadRecords();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "无法加载聊天记录。";
    }
  }
}

async function addAccount() {
  isSaving.value = true;
  errorMessage.value = "";
  notice.value = "";
  try {
    await api("/api/admin/accounts", {
      method: "POST",
      body: JSON.stringify(newAccount),
    });
    newAccount.label = "";
    newAccount.email = "";
    newAccount.password = "";
    newAccount.weight = 1;
    notice.value = "账号验证成功并已添加";
    await loadDashboard();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "无法添加账号。";
  } finally {
    isSaving.value = false;
  }
}

async function verifyAccount(account: Account) {
  account.runtime.lastError = undefined;
  try {
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(account.id)}/verify`, { method: "POST" });
    if (payload.account) {
      replaceAccount(payload.account);
    }
    notice.value = `${account.label} 验证成功`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "账号验证失败。";
  }
}

async function toggleAccount(account: Account) {
  try {
    const payload = await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !account.enabled }),
    });
    if (payload.account) {
      replaceAccount(payload.account);
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "无法更新账号。";
  }
}

async function removeAccount(account: Account) {
  if (!window.confirm(`确定移除账号“${account.label}”吗？`)) {
    return;
  }
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    accounts.value = accounts.value.filter((item) => item.id !== account.id);
    notice.value = "账号已移除";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "无法移除账号。";
  }
}

async function setRecording(value: boolean) {
  try {
    const payload = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ recordMessages: value }),
    });
    settings.recordMessages = payload.settings?.recordMessages ?? value;
    notice.value = value ? "已开启消息记录" : "已关闭消息记录";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "无法更新消息记录设置。";
  }
}

async function clearAllRecords() {
  if (records.value.length === 0 || isClearingRecords.value) {
    return;
  }
  if (!window.confirm("确定清空全部聊天记录吗？此操作不可撤销。")) {
    return;
  }
  isClearingRecords.value = true;
  errorMessage.value = "";
  try {
    await api("/api/admin/records", { method: "DELETE" });
    rawTraceKey.value = null;
    selectedTraceKey.value = null;
    records.value = [];
    notice.value = "已清空全部聊天记录";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "无法清空聊天记录。";
  } finally {
    isClearingRecords.value = false;
  }
}

function replaceAccount(next: Account) {
  const index = accounts.value.findIndex((account) => account.id === next.id);
  if (index === -1) {
    accounts.value.push(next);
  } else {
    accounts.value[index] = next;
  }
}

function formatDate(value: string | number | null | undefined): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function sessionLabel(account: Account): string {
  if (!account.hasSession) {
    return "未登录";
  }
  if (account.sessionExpiresAt && account.sessionExpiresAt < Date.now()) {
    return "已过期";
  }
  return account.sessionExpiresAt ? `有效至 ${formatDate(account.sessionExpiresAt)}` : "有效";
}

function runtimeLabel(account: Account): string {
  if (account.runtime.cooldownUntil > Date.now()) {
    return "冷却中";
  }
  if (account.runtime.inFlight > 0) {
    return `${account.runtime.inFlight} 个请求处理中`;
  }
  return account.enabled ? "就绪" : "已禁用";
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
    input_text: "输入文本",
    output_text: "输出文本",
    function_call: "工具调用",
    function_call_output: "工具结果",
    reasoning: "推理",
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
      if (typeof item.output === "string") return item.output;
      if (typeof item.summary === "string") return item.summary;
      if (Array.isArray(item.summary)) return item.summary.map((entry) => contentText(entry)).filter(Boolean).join("\n");
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
  const type = message.type;
  const role = typeof message.role === "string" ? message.role : type;
  const output = message.output
    ?? message.content
    ?? message.text
    ?? message.summary
    ?? message.reasoning
    ?? message.reasoning_content
    ?? message.refusal
    ?? message.arguments;
  const calls = toolCalls(message.tool_calls);
  if (type === "function_call") {
    calls.push({
      id: typeof message.call_id === "string" ? message.call_id : typeof message.id === "string" ? message.id : "tool_call",
      name: typeof message.name === "string" ? message.name : "未命名工具",
      arguments: contentText(message.arguments ?? {}),
    });
  }
  return {
    role: typeof role === "string" ? role : "assistant",
    roleLabel: roleName(typeof role === "string" ? role : "assistant", type),
    content: contentText(output),
    toolCalls: calls,
  };
}

function collectMessages(value: unknown): DisplayMessage[] {
  const source = asObject(value);
  const candidates: unknown[] = [];
  if (Array.isArray(source?.messages)) candidates.push(...source.messages);
  if (Array.isArray(source?.input)) candidates.push(...source.input);
  if (Array.isArray(source?.output)) candidates.push(...source.output);
  if (Array.isArray(source?.choices)) {
    for (const choice of source.choices) {
      const item = asObject(choice);
      if (item?.message) candidates.push(item.message);
      else if (item?.delta) candidates.push(item.delta);
    }
  }
  if (source?.role || ["message", "function_call", "function_call_output", "reasoning", "input_text", "output_text"].includes(String(source?.type))) {
    candidates.push(source);
  }
  return candidates.map(displayMessage).filter((message): message is DisplayMessage => Boolean(message));
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

function callTitle(call: DebugUpstreamCall): string {
  const base = call.type === "repair"
    ? `纠错轮 ${call.round}`
    : call.type === "continuation"
      ? `续写轮 ${call.round}`
      : "首次请求";
  return call.attempt > 1 ? `${base} · 账号重试 ${call.attempt - 1}` : base;
}

function recordTraces(record: DebugRecord): ConversationTrace[] {
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

const allTraces = computed(() => records.value.flatMap(recordTraces));
const upstreamCallCount = computed(() => allTraces.value.filter((trace) => trace.direction === "upstream").length);
const selectedTrace = computed(() => allTraces.value.find((trace) => trace.key === selectedTraceKey.value) ?? allTraces.value[0]);

function selectTrace(trace: ConversationTrace): void {
  selectedTraceKey.value = trace.key;
  rawTraceKey.value = null;
}

function presentBody(value: DebugRawBody | JsonRecord | undefined): BodyPresentation {
  const values = parsedBodyValues(value);
  const messages = values.flatMap(collectMessages);
  const raw = rawBodyText(value);
  return {
    contentType: bodyContentType(value),
    raw,
    fields: values.flatMap(recordFields),
    messages: messages.length > 0 || !raw
      ? messages
      : [{ role: "raw", roleLabel: "原始文本", content: raw, toolCalls: [] }],
  };
}

function traceRequest(trace: ConversationTrace): BodyPresentation {
  return presentBody(trace.request);
}

function traceResponse(trace: ConversationTrace): BodyPresentation | undefined {
  return trace.response ? presentBody(trace.response) : undefined;
}

function traceRawKey(trace: ConversationTrace): string {
  return `raw:${trace.key}`;
}

function traceRecordLabel(trace: ConversationTrace): string {
  return `${formatDate(trace.record.at)} · ${trace.record.endpoint}`;
}

onMounted(() => {
  if (token.value) {
    void loadDashboard();
  }
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
        <button class="button button-quiet" type="button" :disabled="isLoading" @click="loadDashboard">刷新</button>
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
        <p v-if="errorMessage" class="error-line" role="alert">{{ errorMessage }}</p>
      </section>
    </main>

    <main v-else class="dashboard">
      <section class="dashboard-heading">
        <div>
          <p class="section-kicker">运行概览</p>
          <h1>网关控制台</h1>
        </div>
        <p class="last-update">{{ notice || "就绪" }}</p>
      </section>

      <p v-if="errorMessage" class="banner banner-error" role="alert">{{ errorMessage }}</p>

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
        <section class="workspace-grid">
          <form class="panel account-form" @submit.prevent="addAccount">
            <div class="panel-heading">
              <div>
                <p class="section-kicker">连接池</p>
                <h2>添加账号</h2>
              </div>
              <span class="panel-note">保存时验证登录</span>
            </div>
            <label for="account-label">账号名称</label>
            <input id="account-label" v-model="newAccount.label" type="text" maxlength="120" placeholder="主账号 Kimi" />
            <label for="account-email">门户邮箱</label>
            <input id="account-email" v-model="newAccount.email" type="email" maxlength="320" autocomplete="off" required />
            <label for="account-password">门户密码</label>
            <input id="account-password" v-model="newAccount.password" type="password" maxlength="4096" autocomplete="new-password" required />
            <label for="account-weight">权重</label>
            <input id="account-weight" v-model.number="newAccount.weight" type="number" min="1" max="100" step="1" required />
            <button class="button button-primary form-submit" type="submit" :disabled="isSaving">
              {{ isSaving ? "验证中…" : "添加账号" }}
            </button>
          </form>

          <section class="panel account-list" aria-labelledby="accounts-title">
            <div class="panel-heading">
              <div>
                <p class="section-kicker">调度器</p>
                <h2 id="accounts-title">账号列表</h2>
              </div>
              <span class="panel-note">粘性会话 · 加权负载</span>
            </div>
            <div v-if="accounts.length === 0" class="empty-state">尚未配置账号。</div>
            <div v-else class="account-table-wrap">
              <table class="account-table">
                <thead>
                  <tr><th>账号</th><th>会话</th><th>运行状态</th><th>权重</th><th>操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="account in accounts" :key="account.id">
                    <td>
                      <strong>{{ account.label }}</strong>
                      <span class="muted">{{ account.emailHint }}</span>
                    </td>
                    <td>
                      <span class="state-text" :class="{ good: account.hasSession && !(account.sessionExpiresAt && account.sessionExpiresAt < Date.now()) }">{{ sessionLabel(account) }}</span>
                      <span class="muted">{{ formatDate(account.updatedAt) }}</span>
                    </td>
                    <td>
                      <span class="state-text" :class="{ good: account.enabled && account.runtime.cooldownUntil <= Date.now() }">{{ runtimeLabel(account) }}</span>
                      <span v-if="account.runtime.lastError" class="muted error-detail">{{ account.runtime.lastError }}</span>
                    </td>
                    <td>{{ account.weight }}</td>
                    <td class="action-cell">
                      <button class="text-button" type="button" @click="verifyAccount(account)">验证</button>
                      <button class="text-button" type="button" @click="toggleAccount(account)">{{ account.enabled ? "禁用" : "启用" }}</button>
                      <button class="text-button danger" type="button" @click="removeAccount(account)">移除</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
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
              <button class="button button-danger" type="button" :disabled="records.length === 0 || isClearingRecords" @click="clearAllRecords">
                {{ isClearingRecords ? "清空中…" : "清空全部" }}
              </button>
            </div>
          </div>
          <p class="records-meta">
            {{ settings.recordMessages ? "消息记录已开启" : "消息记录已关闭" }} · {{ records.length }} 个客户端请求 · {{ upstreamCallCount }} 次上游调用
            <template v-if="toolFirstPassRate !== null"> · 工具 JSON 首次解析成功率 {{ toolFirstPassRate }}%（{{ toolAdapterRecords.length }} 轮）</template>
          </p>
          <div v-if="records.length === 0" class="empty-state">暂无聊天记录。</div>
          <div v-else class="conversation-workbench">
            <aside class="trace-sidebar" aria-label="请求发送列表">
              <section v-for="record in records" :key="record.id" class="trace-group">
                <div class="trace-group-meta">
                  <span>{{ formatDate(record.at) }}</span>
                  <span class="trace-group-status" :class="{ success: record.status < 400 }">{{ record.status }}</span>
                </div>
                <button
                  v-for="trace in recordTraces(record).slice(0, 1)"
                  :key="trace.key"
                  class="trace-item trace-client"
                  :class="{ active: selectedTrace?.key === trace.key }"
                  type="button"
                  @click="selectTrace(trace)"
                >
                  <span class="trace-kind">客户端</span>
                  <strong>{{ trace.title }}</strong>
                  <small>{{ trace.subtitle }}</small>
                </button>
                <div v-if="recordTraces(record).length > 1" class="trace-children">
                  <button
                    v-for="trace in recordTraces(record).slice(1)"
                    :key="trace.key"
                    class="trace-item trace-upstream"
                    :class="{ active: selectedTrace?.key === trace.key, failed: trace.status >= 400 || Boolean(trace.error) }"
                    type="button"
                    @click="selectTrace(trace)"
                  >
                    <span class="trace-kind">上游</span>
                    <strong>{{ trace.title }}</strong>
                    <small>{{ trace.subtitle }}</small>
                  </button>
                </div>
              </section>
            </aside>

            <section v-if="selectedTrace" class="conversation-detail" :key="selectedTrace.key">
              <header class="conversation-header">
                <div>
                  <p class="section-kicker">{{ selectedTrace.direction === "client" ? "客户端会话" : "上游调用" }}</p>
                  <h3>{{ selectedTrace.title }}</h3>
                  <p class="conversation-meta">{{ traceRecordLabel(selectedTrace) }} · {{ selectedTrace.subtitle }} · HTTP {{ selectedTrace.status }}</p>
                </div>
                <button class="button button-quiet" type="button" @click="rawTraceKey = rawTraceKey === traceRawKey(selectedTrace) ? null : traceRawKey(selectedTrace)">
                  {{ rawTraceKey === traceRawKey(selectedTrace) ? "查看对话" : "查看原始数据" }}
                </button>
              </header>

              <div v-if="rawTraceKey === traceRawKey(selectedTrace)" class="raw-trace">
                <section>
                  <h4>请求正文 · {{ traceRequest(selectedTrace).contentType }}</h4>
                  <pre>{{ traceRequest(selectedTrace).raw }}</pre>
                </section>
                <section v-if="traceResponse(selectedTrace)">
                  <h4>响应正文 · {{ traceResponse(selectedTrace)?.contentType }}</h4>
                  <pre>{{ traceResponse(selectedTrace)?.raw }}</pre>
                </section>
              </div>

              <div v-else class="conversation-flow">
                <section class="conversation-turn request-turn">
                  <div class="turn-label"><span>发送</span><strong>{{ selectedTrace.direction === "client" ? "客户端请求" : "上游请求" }}</strong></div>
                  <div v-if="traceRequest(selectedTrace).messages.length" class="message-stack">
                    <article v-for="(message, index) in traceRequest(selectedTrace).messages" :key="`request-${index}`" class="message-item message-sent">
                      <div class="message-heading"><strong>{{ message.roleLabel }}</strong></div>
                      <p v-if="message.content" class="message-content">{{ message.content }}</p>
                      <div v-for="call in message.toolCalls" :key="call.id" class="tool-call-item">
                        <span class="tool-call-name">工具：{{ call.name }}</span>
                        <code>{{ call.arguments }}</code>
                      </div>
                    </article>
                  </div>
                  <dl v-if="traceRequest(selectedTrace).fields.length" class="record-fields trace-fields">
                    <template v-for="(field, index) in traceRequest(selectedTrace).fields" :key="`request-field-${index}`">
                      <dt>{{ field.label }}</dt><dd>{{ field.value }}</dd>
                    </template>
                  </dl>
                </section>

                <section class="conversation-turn response-turn">
                  <div class="turn-label"><span>接收</span><strong>{{ selectedTrace.direction === "client" ? "客户端响应" : "上游响应" }}</strong></div>
                  <template v-if="traceResponse(selectedTrace)">
                    <div v-if="traceResponse(selectedTrace)?.messages.length" class="message-stack">
                      <article v-for="(message, index) in traceResponse(selectedTrace)?.messages" :key="`response-${index}`" class="message-item message-received">
                        <div class="message-heading"><strong>{{ message.roleLabel }}</strong></div>
                        <p v-if="message.content" class="message-content">{{ message.content }}</p>
                        <div v-for="call in message.toolCalls" :key="call.id" class="tool-call-item">
                          <span class="tool-call-name">工具：{{ call.name }}</span>
                          <code>{{ call.arguments }}</code>
                        </div>
                      </article>
                    </div>
                    <dl v-if="traceResponse(selectedTrace)?.fields.length" class="record-fields trace-fields">
                      <template v-for="(field, index) in traceResponse(selectedTrace)?.fields" :key="`response-field-${index}`">
                        <dt>{{ field.label }}</dt><dd>{{ field.value }}</dd>
                      </template>
                    </dl>
                  </template>
                  <p v-else class="parsed-empty">尚未收到响应正文。</p>
                </section>

                <p v-if="selectedTrace.error" class="trace-error">{{ selectedTrace.error }}</p>
                <section v-if="selectedTrace.record.toolCallAdapter" class="adapter-trace">
                  <h4>工具调用转换</h4>
                  <dl class="record-fields trace-fields">
                    <dt>预期模式</dt><dd>{{ toolModeLabel(selectedTrace.record.toolCallAdapter.toolCallExpected) }}</dd>
                    <dt>首次结果</dt><dd>{{ toolOutcomeLabel(selectedTrace.record.toolCallAdapter.initialOutcome) }}</dd>
                    <dt>最终结果</dt><dd>{{ toolOutcomeLabel(selectedTrace.record.toolCallAdapter.finalOutcome) }}</dd>
                    <dt>修复次数</dt><dd>{{ selectedTrace.record.toolCallAdapter.repairAttempts }} / {{ selectedTrace.record.toolCallAdapter.maxRepairAttempts }}</dd>
                    <dt>首次解析</dt><dd>{{ selectedTrace.record.toolCallAdapter.initialParseSucceeded ? "成功" : "失败" }}</dd>
                  </dl>
                  <ul v-if="selectedTrace.record.toolCallAdapter.errors.length" class="error-list">
                    <li v-for="error in selectedTrace.record.toolCallAdapter.errors" :key="error">{{ error }}</li>
                  </ul>
                </section>
              </div>
            </section>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>
