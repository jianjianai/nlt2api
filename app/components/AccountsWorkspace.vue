<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import SecretValue from "./ui/SecretValue.vue";
import type { Account, ProxyPoolEntry, SchedulerSettings } from "../types/admin.ts";

const props = defineProps<{
  accounts: Account[];
  proxies: ProxyPoolEntry[];
  scheduler: SchedulerSettings;
  query: string;
  expandedId: string | null;
  busyIds: Set<string>;
  secretResetToken: number;
  copySecret: (value: string, label: string) => void | Promise<void>;
}>();
const emit = defineEmits<{
  "update:query": [value: string];
  "update:expandedId": [value: string | null];
  add: [];
  verify: [account: Account];
  manageProxy: [account: Account];
  assignProxy: [account: Account];
  fetchModels: [account: Account];
  editModels: [account: Account];
  editLimits: [account: Account];
  toggle: [account: Account];
  remove: [account: Account];
}>();

const filtered = computed(() => {
  const query = props.query.trim().toLowerCase();
  if (!query) return props.accounts;
  return props.accounts.filter((account) => account.label.toLowerCase().includes(query)
    || account.email.toLowerCase().includes(query)
    || (account.proxy ?? "").toLowerCase().includes(query));
});

function runtimeState(account: Account): { text: string; tone: string } {
  if (!account.enabled) return { text: "已禁用", tone: "muted" };
  if (account.runtime.cooldownUntil > Date.now()) return { text: "冷却中", tone: "warn" };
  if (account.runtime.inFlight > 0) return { text: `${account.runtime.inFlight} 个请求处理中`, tone: "good" };
  return { text: "可用", tone: "good" };
}

function sessionText(account: Account): string {
  if (!account.hasSession) return "未登录";
  if (account.sessionExpiresAt && account.sessionExpiresAt < Date.now()) return "已过期";
  return "会话有效";
}

function poolEntry(account: Account): ProxyPoolEntry | undefined {
  return account.proxyPoolEntryId ? props.proxies.find((proxy) => proxy.id === account.proxyPoolEntryId) : undefined;
}

function egressText(account: Account): string {
  const pool = poolEntry(account);
  if (pool) return `${pool.kind.toUpperCase()} · 代理池${pool.status === "error" ? "错误" : "使用中"}`;
  return account.proxy ? "自定义代理" : "直连";
}

function nextAvailability(account: Account): string {
  const value = account.runtime.nextRateAvailableAt;
  if (!value || value <= Date.now()) return "当前可用";
  return `${Math.max(1, Math.ceil((value - Date.now()) / 1_000))} 秒后可用`;
}

function toggleExpanded(account: Account): void {
  emit("update:expandedId", props.expandedId === account.id ? null : account.id);
}
</script>

<template>
  <section class="workspace-page accounts-workspace">
    <header class="page-heading page-heading-actions">
      <div><p class="section-kicker">连接资源</p><h1>账号</h1><p>查看账号健康、出口、负载和模型容量；配置操作按需展开。</p></div>
      <button class="button button-primary" type="button" @click="emit('add')"><AppIcon name="plus" :size="14" />添加账号</button>
    </header>

    <div class="workspace-toolbar">
      <label class="search-field"><AppIcon name="search" :size="14" /><span class="sr-only">搜索账号</span><input :value="query" type="search" placeholder="搜索名称、邮箱或代理" @input="emit('update:query', ($event.target as HTMLInputElement).value)" /></label>
      <span class="toolbar-summary">{{ filtered.length }} / {{ accounts.length }} 个账号</span>
    </div>

    <div v-if="accounts.length === 0" class="workspace-empty"><strong>尚未配置账号</strong><p>添加门户账号后，网关才能接收模型请求。</p><button class="button button-primary" type="button" @click="emit('add')"><AppIcon name="plus" :size="14" />添加第一个账号</button></div>
    <div v-else-if="filtered.length === 0" class="workspace-empty"><strong>没有匹配的账号</strong><p>请修改搜索条件后重试。</p></div>

    <div v-else class="account-compact-grid">
      <article v-for="account in filtered" :id="`account-${account.id}`" :key="account.id" class="account-compact-card" :class="{ disabled: !account.enabled, expanded: expandedId === account.id, busy: busyIds.has(account.id) }" :aria-busy="busyIds.has(account.id)">
        <div class="account-compact-head">
          <div class="account-title"><strong>{{ account.label }}</strong><span>{{ account.email }}</span></div>
          <span class="badge" :class="runtimeState(account).tone">{{ runtimeState(account).text }}</span>
        </div>
        <div class="account-runtime-grid">
          <div><span>出口</span><strong>{{ egressText(account) }}</strong></div>
          <div><span>60 秒请求</span><strong>{{ account.runtime.requestsLastMinute }} / {{ account.schedulerOverrides?.accountRpm ?? scheduler.accountRpm }}</strong></div>
          <div><span>模型在途</span><strong>{{ account.runtime.inFlight }} / {{ account.schedulerOverrides?.accountModelConcurrency ?? scheduler.accountModelConcurrency }}</strong></div>
          <div><span>会话</span><strong>{{ sessionText(account) }}</strong></div>
        </div>
        <div class="account-meter" role="meter" aria-label="账号 RPM 使用率" :aria-valuenow="Math.min(100, account.runtime.requestsLastMinute / (account.schedulerOverrides?.accountRpm ?? scheduler.accountRpm) * 100)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${Math.min(100, account.runtime.requestsLastMinute / (account.schedulerOverrides?.accountRpm ?? scheduler.accountRpm) * 100)}%` }"></i></div>
        <div class="account-card-meta"><span>{{ account.models.length }} 个模型</span><span>{{ nextAvailability(account) }}</span></div>
        <p v-if="account.runtime.lastError" class="inline-error">{{ account.runtime.lastError }}</p>
        <footer class="account-card-footer"><span class="card-footer-state"><span v-if="busyIds.has(account.id)" class="spinner" aria-hidden="true"></span>{{ busyIds.has(account.id) ? "操作处理中" : expandedId === account.id ? "配置已展开" : "查看凭据、出口与限额" }}</span><button class="button button-quiet" type="button" :aria-expanded="expandedId === account.id" :disabled="busyIds.has(account.id)" @click="toggleExpanded(account)">{{ expandedId === account.id ? "收起" : "管理" }}<AppIcon :name="expandedId === account.id ? 'chevron-up' : 'chevron-down'" :size="13" /></button></footer>

        <div v-if="expandedId === account.id" class="account-expanded">
          <section><h2>凭据</h2><div class="detail-row"><span>登录邮箱</span><code>{{ account.email }}</code></div><div class="detail-row"><span>账号密码</span><SecretValue :value="account.password" :label="`${account.label} 的账号密码`" :reset-token="secretResetToken" :copy="copySecret" /></div></section>
          <section><h2>出口</h2><div class="detail-row"><span>当前出口</span><code>{{ poolEntry(account)?.maskedUrl ?? (account.proxy ? "自定义代理（凭据已保护）" : "直连") }}</code></div><p>更换出口不会主动退出账号；门户拒绝现有会话时才重新登录。</p><div class="detail-actions"><button v-if="!account.proxy" class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('assignProxy', account)"><AppIcon name="globe" :size="13" />从代理池分配</button><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('manageProxy', account)"><AppIcon name="settings" :size="13" />管理代理</button></div></section>
          <section><h2>模型</h2><div class="model-chips"><span v-for="model in account.models" :key="model" class="model-chip">{{ model }}</span><span v-if="!account.models.length" class="muted">未配置模型</span></div><div class="detail-actions"><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('fetchModels', account)"><AppIcon name="refresh-cw" :size="13" />自动获取</button><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('editModels', account)"><AppIcon name="file-text" :size="13" />编辑列表</button></div></section>
          <section><h2>限额与状态</h2><p>账号 RPM 和模型并发留空时继承全局调度设置。</p><div class="detail-actions"><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('editLimits', account)"><AppIcon name="gauge" :size="13" />编辑限额</button><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" :aria-busy="busyIds.has(account.id)" @click="emit('verify', account)"><span v-if="busyIds.has(account.id)" class="spinner" aria-hidden="true"></span><AppIcon v-else name="activity" :size="13" />{{ busyIds.has(account.id) ? "处理中" : "验证账号" }}</button><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('toggle', account)">{{ account.enabled ? "禁用" : "启用" }}</button><button class="button button-danger" type="button" :disabled="busyIds.has(account.id)" @click="emit('remove', account)">移除</button></div></section>
        </div>
      </article>
    </div>
  </section>
</template>
