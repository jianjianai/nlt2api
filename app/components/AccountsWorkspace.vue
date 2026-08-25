<script setup lang="ts">
import { computed, ref, watch } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import type {
  Account,
  AccountGroup,
  AccountGroupSummary,
  AccountPagination,
  AccountSort,
  AccountStatusFilter,
  ProxyPoolEntry,
  SchedulerSettings,
} from "../types/admin.ts";

const props = defineProps<{
  accounts: Account[];
  groups: AccountGroup[];
  groupSummary: AccountGroupSummary;
  pagination: AccountPagination;
  groupFilter: string;
  statusFilter: AccountStatusFilter;
  sort: AccountSort;
  pageSize: 20 | 50 | 100;
  proxies: ProxyPoolEntry[];
  scheduler: SchedulerSettings;
  query: string;
  expandedId: string | null;
  busyIds: Set<string>;
  loading: boolean;
}>();
const emit = defineEmits<{
  "update:query": [value: string];
  "update:expandedId": [value: string | null];
  selectGroup: [value: string];
  setStatus: [value: AccountStatusFilter];
  setSort: [value: AccountSort];
  setPageSize: [value: 20 | 50 | 100];
  setPage: [value: number];
  add: [];
  addGroup: [];
  editGroup: [group: AccountGroup];
  manageKeys: [group: AccountGroup];
  saveMembership: [account: Account, groupIds: string[]];
  verify: [account: Account];
  manageProxy: [account: Account];
  assignProxy: [account: Account];
  fetchModels: [account: Account];
  editModels: [account: Account];
  editLimits: [account: Account];
  toggle: [account: Account];
  remove: [account: Account];
}>();

const membershipDrafts = ref<Record<string, string[]>>({});
const selectedGroup = computed(() => props.groups.find((group) => group.id === props.groupFilter));
const groupTitle = computed(() => selectedGroup.value?.name ?? (props.groupFilter === "ungrouped" ? "未分组" : "全部账号"));
const visiblePages = computed(() => {
  const current = props.pagination.page;
  const last = props.pagination.pageCount;
  const values = new Set([1, last, current - 1, current, current + 1]);
  return [...values].filter((page) => page >= 1 && page <= last).sort((a, b) => a - b);
});

watch(() => props.expandedId, (id) => {
  if (!id) return;
  const account = props.accounts.find((candidate) => candidate.id === id);
  if (account) membershipDrafts.value = { ...membershipDrafts.value, [id]: [...account.groupIds] };
});

function runtimeState(account: Account): { text: string; tone: string } {
  if (!account.enabled) return { text: "已禁用", tone: "muted" };
  if (account.runtime.cooldownUntil > Date.now()) return { text: "冷却中", tone: "warn" };
  if (account.runtime.inFlight > 0) return { text: `${account.runtime.inFlight} 个请求处理中`, tone: "good" };
  return { text: "可用", tone: "good" };
}
function sessionText(): string {
  return "匿名票据 · 按请求现铸";
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
function groupCount(id: string): number {
  return props.groups.find((group) => group.id === id)?.accountCount ?? 0;
}
function draftGroups(account: Account): string[] {
  return membershipDrafts.value[account.id] ?? account.groupIds;
}
function setDraftGroup(account: Account, groupId: string, checked: boolean): void {
  const next = new Set(draftGroups(account));
  if (checked) next.add(groupId); else next.delete(groupId);
  membershipDrafts.value = { ...membershipDrafts.value, [account.id]: [...next] };
}
function saveMembership(account: Account): void {
  emit("saveMembership", account, draftGroups(account));
}
</script>

<template>
  <section class="workspace-page accounts-workspace">
    <header class="page-heading page-heading-actions">
      <div><p class="section-kicker">连接资源</p><h1>账号与分组</h1><p>按分组绑定账号、签发访问密钥，并在服务端分页查询运行状态。</p></div>
      <button class="button button-primary" type="button" @click="emit('add')"><AppIcon name="plus" :size="14" />添加账号</button>
    </header>

    <div class="account-mobile-group">
      <label for="account-group-select">账号分组</label>
      <select id="account-group-select" :value="groupFilter" @change="emit('selectGroup', ($event.target as HTMLSelectElement).value)">
        <option value="all">全部账号（{{ groupSummary.totalAccounts }}）</option>
        <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}（{{ group.accountCount }}）</option>
        <option value="ungrouped">未分组（{{ groupSummary.ungroupedAccounts }}）</option>
      </select>
    </div>

    <div class="accounts-layout">
      <aside class="account-group-rail" aria-label="账号分组">
        <div class="account-group-rail-head"><strong>账号分组</strong><button class="icon-action" type="button" aria-label="创建账号分组" title="创建账号分组" @click="emit('addGroup')"><AppIcon name="plus" :size="14" /></button></div>
        <button type="button" :class="{ active: groupFilter === 'all' }" @click="emit('selectGroup', 'all')"><span><AppIcon name="users" :size="14" />全部账号</span><b>{{ groupSummary.totalAccounts }}</b></button>
        <button v-for="group in groups" :key="group.id" type="button" :class="{ active: groupFilter === group.id, disabled: !group.enabled }" @click="emit('selectGroup', group.id)"><span><AppIcon name="key" :size="14" />{{ group.name }}</span><b>{{ groupCount(group.id) }}</b></button>
        <button type="button" :class="{ active: groupFilter === 'ungrouped' }" @click="emit('selectGroup', 'ungrouped')"><span><AppIcon name="inbox" :size="14" />未分组</span><b>{{ groupSummary.ungroupedAccounts }}</b></button>
      </aside>

      <div class="account-list-pane">
        <div class="account-context-head">
          <div><span>当前范围</span><h2>{{ groupTitle }}</h2><p>{{ selectedGroup?.description || (groupFilter === 'all' ? '所有账号均可由主 API Key 调度。' : groupFilter === 'ungrouped' ? '这些账号只能由主 API Key 调度。' : '该组的 Key 只能调度组内账号。') }}</p></div>
          <div v-if="selectedGroup" class="page-actions"><button class="button button-quiet" type="button" @click="emit('editGroup', selectedGroup)"><AppIcon name="settings" :size="13" />编辑分组</button><button class="button button-quiet" type="button" @click="emit('manageKeys', selectedGroup)"><AppIcon name="key" :size="13" />管理 API Key</button></div>
        </div>

        <div class="workspace-toolbar account-toolbar">
          <label class="search-field"><AppIcon name="search" :size="14" /><span class="sr-only">搜索账号</span><input :value="query" type="search" placeholder="搜索名称或代理" @input="emit('update:query', ($event.target as HTMLInputElement).value)" /></label>
          <div class="account-filter-row">
            <label><span class="sr-only">账号状态</span><select :value="statusFilter" @change="emit('setStatus', ($event.target as HTMLSelectElement).value as AccountStatusFilter)"><option value="all">全部状态</option><option value="enabled">仅启用</option><option value="disabled">仅禁用</option></select></label>
            <label><span class="sr-only">排序</span><select :value="sort" @change="emit('setSort', ($event.target as HTMLSelectElement).value as AccountSort)"><option value="created_desc">最新添加</option><option value="created_asc">最早添加</option><option value="label_asc">名称升序</option><option value="label_desc">名称降序</option></select></label>
            <label><span class="sr-only">每页数量</span><select :value="pageSize" @change="emit('setPageSize', Number(($event.target as HTMLSelectElement).value) as 20 | 50 | 100)"><option :value="20">20 / 页</option><option :value="50">50 / 页</option><option :value="100">100 / 页</option></select></label>
          </div>
        </div>

        <div v-if="loading" class="workspace-empty account-loading"><span class="spinner" aria-hidden="true"></span><strong>正在加载账号</strong></div>
        <div v-else-if="pagination.total === 0" class="workspace-empty"><strong>{{ query ? '没有匹配的账号' : '当前范围没有账号' }}</strong><p>{{ query ? '请修改搜索或筛选条件后重试。' : '添加账号或调整账号的分组成员关系。' }}</p><button v-if="!query" class="button button-primary" type="button" @click="emit('add')"><AppIcon name="plus" :size="14" />添加账号</button></div>

        <div v-else class="account-compact-grid">
          <article v-for="account in accounts" :id="`account-${account.id}`" :key="account.id" class="account-compact-card" :class="{ disabled: !account.enabled, expanded: expandedId === account.id, busy: busyIds.has(account.id) }" :aria-busy="busyIds.has(account.id)">
            <div class="account-compact-head"><div class="account-title"><strong>{{ account.label }}</strong><span>DeepInfra 匿名出口账号</span></div><span class="badge" :class="runtimeState(account).tone">{{ runtimeState(account).text }}</span></div>
            <div class="account-runtime-grid"><div><span>出口</span><strong>{{ egressText(account) }}</strong></div><div><span>60 秒请求</span><strong>{{ account.runtime.requestsLastMinute }} / {{ account.schedulerOverrides?.accountRpm ?? scheduler.accountRpm }}</strong></div><div><span>模型在途</span><strong>{{ account.runtime.inFlight }} / {{ account.schedulerOverrides?.accountModelConcurrency ?? scheduler.accountModelConcurrency }}</strong></div><div><span>鉴权</span><strong>{{ sessionText() }}</strong></div></div>
            <div class="account-meter" role="meter" aria-label="账号 RPM 使用率" :aria-valuenow="Math.min(100, account.runtime.requestsLastMinute / (account.schedulerOverrides?.accountRpm ?? scheduler.accountRpm) * 100)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${Math.min(100, account.runtime.requestsLastMinute / (account.schedulerOverrides?.accountRpm ?? scheduler.accountRpm) * 100)}%` }"></i></div>
            <div class="account-card-meta"><span>{{ account.models.length }} 个模型 · {{ account.groupIds.length }} 个分组</span><span>{{ nextAvailability(account) }}</span></div>
            <p v-if="account.runtime.lastError" class="inline-error">{{ account.runtime.lastError }}</p>
            <footer class="account-card-footer"><span class="card-footer-state"><span v-if="busyIds.has(account.id)" class="spinner" aria-hidden="true"></span>{{ busyIds.has(account.id) ? '操作处理中' : expandedId === account.id ? '配置已展开' : '查看出口、分组与限额' }}</span><button class="button button-quiet" type="button" :aria-expanded="expandedId === account.id" :disabled="busyIds.has(account.id)" @click="toggleExpanded(account)">{{ expandedId === account.id ? '收起' : '管理' }}<AppIcon :name="expandedId === account.id ? 'chevron-up' : 'chevron-down'" :size="13" /></button></footer>

            <div v-if="expandedId === account.id" class="account-expanded">
              <section><h2>账号分组</h2><p>账号可同时属于多个分组；账号容量和限额仍全局共享。</p><div class="membership-list"><label v-for="group in groups" :key="group.id"><input type="checkbox" :checked="draftGroups(account).includes(group.id)" :disabled="busyIds.has(account.id)" @change="setDraftGroup(account, group.id, ($event.target as HTMLInputElement).checked)" /><span>{{ group.name }}</span><small>{{ group.enabled ? `${group.apiKeyCount} 个 Key` : '已停用' }}</small></label><span v-if="groups.length === 0" class="muted">尚未创建分组</span></div><div class="detail-actions"><button class="button button-primary" type="button" :disabled="busyIds.has(account.id)" @click="saveMembership(account)">保存分组</button></div></section>
              <section><h2>出口</h2><div class="detail-row"><span>当前出口</span><code>{{ poolEntry(account)?.maskedUrl ?? (account.proxy ? '自定义代理（凭据已保护）' : '直连') }}</code></div><p>账号代表一个稳定出口；出口失败时账号进入冷却，调度器自动选择其他账号。</p><div class="detail-actions"><button v-if="!account.proxy" class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('assignProxy', account)"><AppIcon name="globe" :size="13" />从代理池分配</button><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('manageProxy', account)"><AppIcon name="settings" :size="13" />管理代理</button></div></section>
              <section><h2>模型</h2><div class="model-chips"><span v-for="model in account.models" :key="model" class="model-chip">{{ model }}</span><span v-if="!account.models.length" class="muted">未配置模型</span></div><div class="detail-actions"><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('fetchModels', account)"><AppIcon name="refresh-cw" :size="13" />自动获取</button><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('editModels', account)"><AppIcon name="file-text" :size="13" />编辑列表</button></div></section>
              <section><h2>限额与状态</h2><p>账号 RPM 和模型并发留空时继承全局调度设置。</p><div class="detail-actions"><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('editLimits', account)"><AppIcon name="gauge" :size="13" />编辑限额</button><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('verify', account)"><AppIcon name="activity" :size="13" />验证账号</button><button class="button button-quiet" type="button" :disabled="busyIds.has(account.id)" @click="emit('toggle', account)">{{ account.enabled ? '禁用' : '启用' }}</button><button class="button button-danger" type="button" :disabled="busyIds.has(account.id)" @click="emit('remove', account)">移除</button></div></section>
            </div>
          </article>
        </div>

        <nav v-if="pagination.pageCount > 1" class="account-pagination" aria-label="账号分页"><button class="icon-action" type="button" aria-label="第一页" :disabled="pagination.page === 1" @click="emit('setPage', 1)"><AppIcon name="arrow-left" :size="13" /></button><button class="icon-action" type="button" aria-label="上一页" :disabled="pagination.page === 1" @click="emit('setPage', pagination.page - 1)"><AppIcon name="chevron-left" :size="13" /></button><button v-for="page in visiblePages" :key="page" type="button" :class="{ active: page === pagination.page }" :aria-current="page === pagination.page ? 'page' : undefined" @click="emit('setPage', page)">{{ page }}</button><button class="icon-action" type="button" aria-label="下一页" :disabled="pagination.page === pagination.pageCount" @click="emit('setPage', pagination.page + 1)"><AppIcon name="chevron-right" :size="13" /></button><button class="icon-action" type="button" aria-label="最后一页" :disabled="pagination.page === pagination.pageCount" @click="emit('setPage', pagination.pageCount)"><AppIcon name="arrow-right" :size="13" /></button><span>第 {{ pagination.page }} / {{ pagination.pageCount }} 页 · {{ pagination.total }} 个账号</span></nav>
      </div>
    </div>
  </section>
</template>
