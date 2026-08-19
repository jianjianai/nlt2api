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

interface DebugRecord {
  id: string;
  at: string;
  endpoint: string;
  accountId?: string;
  accountLabel?: string;
  clientRequest: Record<string, unknown>;
  upstreamRequest?: Record<string, unknown>;
  clientResponse?: Record<string, unknown>;
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
    storeKeyConfigured: boolean;
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
  storeKeyConfigured: false,
  defaultModel: "",
});
const newAccount = reactive({ label: "", email: "", password: "", weight: 1 });
const isLoading = ref(false);
const isSaving = ref(false);
const isClearingRecords = ref(false);
const rawRecordId = ref<string | null>(null);
const errorMessage = ref("");
const notice = ref("");

const enabledCount = computed(() => accounts.value.filter((account) => account.enabled).length);
const activeSessions = computed(() => accounts.value.filter((account) => account.hasSession).length);
const cooldownCount = computed(() => accounts.value.filter((account) => account.runtime.cooldownUntil > Date.now()).length);
function forcesTool(record: DebugRecord): boolean {
  const choice = record.clientRequest.tool_choice;
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
    rawRecordId.value = null;
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

function displayValue(value: unknown, maxLength = 280): string {
  const text = typeof value === "string" ? value : pretty(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
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
  const output = message.output ?? message.content ?? message.text ?? message.arguments;
  const calls = toolCalls(message.tool_calls);
  if (type === "function_call") {
    calls.push({
      id: typeof message.call_id === "string" ? message.call_id : typeof message.id === "string" ? message.id : "tool_call",
      name: typeof message.name === "string" ? message.name : "未命名工具",
      arguments: contentText(message.arguments ?? {}),
    });
  }
  return {
    role: typeof role === "string" ? role : "message",
    roleLabel: roleName(role, type),
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
    .filter(([key, item]) => !["messages", "input", "output", "choices", "tools", "tool_calls", "content"].includes(key) && item !== undefined)
    .slice(0, 14)
    .map(([key, item]) => {
      if (key === "stream" || key === "parallel_tool_calls") {
        return { label: fieldNames[key] ?? key, value: item ? "是" : "否" };
      }
      if (key === "usage") {
        const usage = asObject(item);
        if (usage) {
          const prompt = usage.prompt_tokens ?? usage.input_tokens;
          const completion = usage.completion_tokens ?? usage.output_tokens;
          const total = usage.total_tokens;
          return {
            label: fieldNames[key] ?? key,
            value: [prompt === undefined ? "" : `输入 ${prompt}`, completion === undefined ? "" : `输出 ${completion}`, total === undefined ? "" : `合计 ${total}`].filter(Boolean).join(" · "),
          };
        }
      }
      if (key === "tool_choice") {
        const choice = asObject(item);
        const fn = asObject(choice?.function);
        if (typeof fn?.name === "string") {
          return { label: fieldNames[key] ?? key, value: `函数：${fn.name}` };
        }
      }
      if (key === "response_format") {
        const format = asObject(item);
        if (typeof format?.type === "string") {
          return { label: fieldNames[key] ?? key, value: format.type };
        }
      }
      if (key === "error") {
        const error = asObject(item);
        if (typeof error?.message === "string") {
          return { label: fieldNames[key] ?? key, value: error.message };
        }
      }
      return { label: fieldNames[key] ?? key, value: displayValue(item) };
    });
}

function recordSections(record: DebugRecord): ParsedSection[] {
  const sections: Array<[string, string, unknown]> = [
    ["client-request", "客户端请求", record.clientRequest],
    ["upstream-request", "上游请求", record.upstreamRequest],
    ["client-response", "客户端响应", record.clientResponse ?? (record.error ? { error: record.error } : undefined)],
    ["upstream-response", "上游响应", record.upstreamResponse],
  ];
  return sections
    .filter(([, , value]) => value !== undefined)
    .map(([key, title, value]) => ({ key, title, fields: recordFields(value), messages: collectMessages(value) }));
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
      <p v-if="!config.storeKeyConfigured" class="banner banner-warning">尚未配置 NEURALWATT_STORE_KEY。在启用加密存储前无法修改账号。</p>

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
              <h2>客户端与上游消息</h2>
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
            {{ settings.recordMessages ? "消息记录已开启" : "消息记录已关闭" }} · 已加载 {{ records.length }} 条记录
            <template v-if="toolFirstPassRate !== null"> · 工具 JSON 首次解析成功率 {{ toolFirstPassRate }}%（{{ toolAdapterRecords.length }} 轮）</template>
          </p>
          <div v-if="records.length === 0" class="empty-state">暂无聊天记录。</div>
          <div v-else class="records-list">
            <details v-for="record in records" :key="record.id" class="record-entry">
              <summary>
                <span class="record-endpoint">{{ record.endpoint }}</span>
                <span class="record-account">{{ record.accountLabel || "未分配账号" }}</span>
                <span class="record-status" :class="{ success: record.status < 400 }">{{ record.status }}</span>
                <span v-if="record.toolCallAdapter" class="record-account">
                  {{ record.toolCallAdapter.finalOutcome === "final" ? "最终 JSON" : record.toolCallAdapter.initialOutcome === "tool_calls" ? "工具 JSON 首次成功" : `工具 JSON 已修复 ×${record.toolCallAdapter.repairAttempts}` }}
                </span>
                <time>{{ formatDate(record.at) }}</time>
              </summary>
              <div class="record-detail">
                <div class="record-detail-toolbar">
                  <span class="record-id">记录 {{ record.id }}</span>
                  <button class="text-button" type="button" @click.stop="rawRecordId = rawRecordId === record.id ? null : record.id">
                    {{ rawRecordId === record.id ? "查看解析内容" : "查看原始 JSON" }}
                  </button>
                </div>
                <div v-if="rawRecordId !== record.id" class="record-grid parsed-record">
                  <section v-for="section in recordSections(record)" :key="section.key" class="parsed-section">
                    <h3>{{ section.title }}</h3>
                    <dl v-if="section.fields.length" class="record-fields">
                      <template v-for="field in section.fields" :key="field.label">
                        <dt>{{ field.label }}</dt><dd :title="field.value">{{ field.value }}</dd>
                      </template>
                    </dl>
                    <div v-if="section.messages.length" class="message-stack">
                      <article v-for="(message, index) in section.messages" :key="`${section.key}-${index}`" class="message-item">
                        <div class="message-heading"><strong>{{ message.roleLabel }}</strong></div>
                        <p v-if="message.content" class="message-content">{{ message.content }}</p>
                        <div v-for="call in message.toolCalls" :key="call.id" class="tool-call-item">
                          <span class="tool-call-name">工具：{{ call.name }}</span>
                          <code>{{ call.arguments }}</code>
                        </div>
                      </article>
                    </div>
                    <p v-if="!section.fields.length && !section.messages.length" class="parsed-empty">无可解析内容</p>
                  </section>
                  <section v-if="record.toolCallAdapter" class="parsed-section">
                    <h3>工具调用转换</h3>
                    <dl class="record-fields">
                      <dt>预期模式</dt><dd>{{ toolModeLabel(record.toolCallAdapter.toolCallExpected) }}</dd>
                      <dt>首次结果</dt><dd>{{ toolOutcomeLabel(record.toolCallAdapter.initialOutcome) }}</dd>
                      <dt>最终结果</dt><dd>{{ toolOutcomeLabel(record.toolCallAdapter.finalOutcome) }}</dd>
                      <dt>修复次数</dt><dd>{{ record.toolCallAdapter.repairAttempts }} / {{ record.toolCallAdapter.maxRepairAttempts }}</dd>
                      <dt>首次解析</dt><dd>{{ record.toolCallAdapter.initialParseSucceeded ? "成功" : "失败" }}</dd>
                    </dl>
                    <ul v-if="record.toolCallAdapter.errors.length" class="error-list">
                      <li v-for="error in record.toolCallAdapter.errors" :key="error">{{ error }}</li>
                    </ul>
                  </section>
                </div>
                <pre v-else class="raw-record-json">{{ pretty(record) }}</pre>
              </div>
            </details>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>
