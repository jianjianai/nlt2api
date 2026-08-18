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
const errorMessage = ref("");
const notice = ref("");

const enabledCount = computed(() => accounts.value.filter((account) => account.enabled).length);
const activeSessions = computed(() => accounts.value.filter((account) => account.hasSession).length);
const cooldownCount = computed(() => accounts.value.filter((account) => account.runtime.cooldownUntil > Date.now()).length);

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
    throw new Error(payload.error?.message || `Request failed (${response.status})`);
  }
  return payload;
}

function useToken() {
  const value = tokenDraft.value.trim();
  if (!value) {
    errorMessage.value = "Enter an admin token.";
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
    notice.value = "Updated just now";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Unable to load dashboard.";
    if (errorMessage.value.includes("Invalid admin token")) {
      token.value = "";
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
      errorMessage.value = error instanceof Error ? error.message : "Unable to load records.";
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
    notice.value = "Account verified and added";
    await loadDashboard();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Unable to add account.";
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
    notice.value = `${account.label} verified`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Account verification failed.";
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
    errorMessage.value = error instanceof Error ? error.message : "Unable to update account.";
  }
}

async function removeAccount(account: Account) {
  if (!window.confirm(`Remove ${account.label}?`)) {
    return;
  }
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    accounts.value = accounts.value.filter((item) => item.id !== account.id);
    notice.value = "Account removed";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Unable to remove account.";
  }
}

async function setRecording(value: boolean) {
  try {
    const payload = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ recordMessages: value }),
    });
    settings.recordMessages = payload.settings?.recordMessages ?? value;
    notice.value = value ? "Message recording enabled" : "Message recording disabled";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Unable to update recording setting.";
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
    return "Not signed in";
  }
  if (account.sessionExpiresAt && account.sessionExpiresAt < Date.now()) {
    return "Expired";
  }
  return account.sessionExpiresAt ? `Until ${formatDate(account.sessionExpiresAt)}` : "Active";
}

function runtimeLabel(account: Account): string {
  if (account.runtime.cooldownUntil > Date.now()) {
    return "Cooling down";
  }
  if (account.runtime.inFlight > 0) {
    return `${account.runtime.inFlight} in flight`;
  }
  return account.enabled ? "Ready" : "Disabled";
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
        <span>NeuralWatt gateway</span>
      </div>
      <div v-if="token" class="topbar-actions">
        <span class="connection-dot" :class="{ busy: isLoading }"></span>
        <span class="topbar-status">{{ isLoading ? "Refreshing" : "Connected" }}</span>
        <button class="button button-quiet" type="button" :disabled="isLoading" @click="loadDashboard">Reload</button>
        <button class="button button-quiet" type="button" @click="signOut">Sign out</button>
      </div>
    </header>

    <main v-if="!token" class="access-page">
      <section class="access-panel" aria-labelledby="access-title">
        <p class="section-kicker">Administrator access</p>
        <h1 id="access-title">Gateway control</h1>
        <p class="access-copy">Use the server-side admin token to continue.</p>
        <form class="access-form" @submit.prevent="useToken">
          <label for="admin-token">Admin token</label>
          <input id="admin-token" v-model="tokenDraft" type="password" autocomplete="off" spellcheck="false" />
          <button class="button button-primary" type="submit">Open dashboard</button>
        </form>
        <p v-if="errorMessage" class="error-line" role="alert">{{ errorMessage }}</p>
      </section>
    </main>

    <main v-else class="dashboard">
      <section class="dashboard-heading">
        <div>
          <p class="section-kicker">Operations</p>
          <h1>Gateway control</h1>
        </div>
        <p class="last-update">{{ notice || "Ready" }}</p>
      </section>

      <p v-if="errorMessage" class="banner banner-error" role="alert">{{ errorMessage }}</p>
      <p v-if="!config.storeKeyConfigured" class="banner banner-warning">NEURALWATT_STORE_KEY is not configured. Account changes are blocked until encrypted storage is available.</p>

      <section class="metric-grid" aria-label="Gateway status">
        <article class="metric">
          <span class="metric-label">Enabled accounts</span>
          <strong>{{ enabledCount }}<small>/{{ accounts.length }}</small></strong>
        </article>
        <article class="metric">
          <span class="metric-label">Active sessions</span>
          <strong>{{ activeSessions }}</strong>
        </article>
        <article class="metric">
          <span class="metric-label">Cooldowns</span>
          <strong>{{ cooldownCount }}</strong>
        </article>
        <article class="metric metric-wide">
          <span class="metric-label">Default model</span>
          <strong class="metric-model">{{ config.defaultModel || "-" }}</strong>
        </article>
      </section>

      <nav class="view-tabs" aria-label="Gateway views">
        <button type="button" :class="{ active: view === 'accounts' }" @click="selectView('accounts')">Accounts</button>
        <button type="button" :class="{ active: view === 'records' }" @click="selectView('records')">Message records</button>
      </nav>

      <template v-if="view === 'accounts'">
        <section class="workspace-grid">
          <form class="panel account-form" @submit.prevent="addAccount">
            <div class="panel-heading">
              <div>
                <p class="section-kicker">Connection pool</p>
                <h2>Add account</h2>
              </div>
              <span class="panel-note">Login checked on save</span>
            </div>
            <label for="account-label">Label</label>
            <input id="account-label" v-model="newAccount.label" type="text" maxlength="120" placeholder="Primary Kimi" />
            <label for="account-email">Portal email</label>
            <input id="account-email" v-model="newAccount.email" type="email" maxlength="320" autocomplete="off" required />
            <label for="account-password">Portal password</label>
            <input id="account-password" v-model="newAccount.password" type="password" maxlength="4096" autocomplete="new-password" required />
            <label for="account-weight">Weight</label>
            <input id="account-weight" v-model.number="newAccount.weight" type="number" min="1" max="100" step="1" required />
            <button class="button button-primary form-submit" type="submit" :disabled="isSaving">
              {{ isSaving ? "Verifying..." : "Add account" }}
            </button>
          </form>

          <section class="panel account-list" aria-labelledby="accounts-title">
            <div class="panel-heading">
              <div>
                <p class="section-kicker">Scheduler</p>
                <h2 id="accounts-title">Managed accounts</h2>
              </div>
              <span class="panel-note">Sticky sessions · weighted load</span>
            </div>
            <div v-if="accounts.length === 0" class="empty-state">No accounts configured.</div>
            <div v-else class="account-table-wrap">
              <table class="account-table">
                <thead>
                  <tr><th>Account</th><th>Session</th><th>Runtime</th><th>Weight</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  <tr v-for="account in accounts" :key="account.id">
                    <td>
                      <strong>{{ account.label }}</strong>
                      <span class="muted">{{ account.emailHint }}</span>
                    </td>
                    <td>
                      <span class="state-text" :class="{ good: account.hasSession && sessionLabel(account) !== 'Expired' }">{{ sessionLabel(account) }}</span>
                      <span class="muted">{{ formatDate(account.updatedAt) }}</span>
                    </td>
                    <td>
                      <span class="state-text" :class="{ good: account.enabled && account.runtime.cooldownUntil <= Date.now() }">{{ runtimeLabel(account) }}</span>
                      <span v-if="account.runtime.lastError" class="muted error-detail">{{ account.runtime.lastError }}</span>
                    </td>
                    <td>{{ account.weight }}</td>
                    <td class="action-cell">
                      <button class="text-button" type="button" @click="verifyAccount(account)">Verify</button>
                      <button class="text-button" type="button" @click="toggleAccount(account)">{{ account.enabled ? "Disable" : "Enable" }}</button>
                      <button class="text-button danger" type="button" @click="removeAccount(account)">Remove</button>
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
              <p class="section-kicker">Debug stream</p>
              <h2>Client and upstream messages</h2>
            </div>
            <div class="record-control">
              <label class="switch-label" for="record-toggle">Record messages</label>
              <button id="record-toggle" class="switch" :class="{ on: settings.recordMessages }" type="button" :aria-pressed="settings.recordMessages" @click="setRecording(!settings.recordMessages)">
                <span></span>
              </button>
              <button class="button button-quiet" type="button" @click="loadRecords">Refresh</button>
            </div>
          </div>
          <p class="records-meta">{{ settings.recordMessages ? "Recording enabled" : "Recording disabled" }} · {{ records.length }} records loaded</p>
          <div v-if="records.length === 0" class="empty-state">No message records.</div>
          <div v-else class="records-list">
            <details v-for="record in records" :key="record.id" class="record-entry">
              <summary>
                <span class="record-endpoint">{{ record.endpoint }}</span>
                <span class="record-account">{{ record.accountLabel || "Unassigned" }}</span>
                <span class="record-status" :class="{ success: record.status < 400 }">{{ record.status }}</span>
                <time>{{ formatDate(record.at) }}</time>
              </summary>
              <div class="record-grid">
                <div><h3>Client request</h3><pre>{{ pretty(record.clientRequest) }}</pre></div>
                <div><h3>Upstream request</h3><pre>{{ pretty(record.upstreamRequest || {}) }}</pre></div>
                <div><h3>Client response</h3><pre>{{ pretty(record.clientResponse || { error: record.error }) }}</pre></div>
                <div><h3>Upstream response</h3><pre>{{ pretty(record.upstreamResponse || {}) }}</pre></div>
              </div>
            </details>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>
