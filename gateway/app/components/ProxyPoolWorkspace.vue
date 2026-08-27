<script setup lang="ts">
import { computed, ref } from "vue";
import AppDisclosure from "./ui/AppDisclosure.vue";
import AppIcon from "./ui/AppIcon.vue";
import type { ImportSummary, ProxyFilter, ProxyKind, ProxyPublic, ProxyStatus } from "../types/admin.ts";
import { formatLatency, formatRelative, formatSpeed, PROXY_STATUS_LABEL, PROXY_STATUS_TONE } from "../utils/admin-ui.ts";

const props = defineProps<{
  proxies: ProxyPublic[];
  counts: Record<ProxyStatus, number>;
  total: number;
  filter: ProxyFilter;
  page: number;
  pageSize: number;
  pageTotal: number;
  selectedIds: Set<string>;
  importText: string;
  importProtocol: ProxyKind;
  importSummary: ImportSummary | null;
  busyIds: Set<string>;
  importing: boolean;
  checking: boolean;
  removing: boolean;
  now: number;
}>();

const emit = defineEmits<{
  "update:filter": [value: ProxyFilter];
  "update:page": [value: number];
  "update:pageSize": [value: number];
  "update:selectedIds": [value: Set<string>];
  "update:importText": [value: string];
  "update:importProtocol": [value: ProxyKind];
  import: [];
  checkScope: [scope: "pending" | "unavailable" | "all"];
  checkSelected: [];
  deleteSelected: [];
  check: [proxy: ProxyPublic];
  reactivate: [proxy: ProxyPublic];
  delete: [proxy: ProxyPublic];
}>();

const importOpen = ref(false);
const filters = computed<Array<{ id: ProxyFilter; label: string; count: number }>>(() => [
  { id: "all", label: "全部", count: props.total },
  { id: "active", label: PROXY_STATUS_LABEL.active, count: props.counts.active },
  { id: "pending", label: PROXY_STATUS_LABEL.pending, count: props.counts.pending },
  { id: "unavailable", label: PROXY_STATUS_LABEL.unavailable, count: props.counts.unavailable },
  { id: "rejected", label: PROXY_STATUS_LABEL.rejected, count: props.counts.rejected },
]);
const protocols: ProxyKind[] = ["http", "socks5", "socks4"];
const pageSizes = [20, 50, 100, 200];

const pageCount = computed(() => Math.max(1, Math.ceil(props.pageTotal / props.pageSize)));
const allPageSelected = computed(() => (
  props.proxies.length > 0 && props.proxies.every((proxy) => props.selectedIds.has(proxy.id))
));

function toggleAll(): void {
  const next = new Set(props.selectedIds);
  if (allPageSelected.value) {
    for (const proxy of props.proxies) next.delete(proxy.id);
  } else {
    for (const proxy of props.proxies) next.add(proxy.id);
  }
  emit("update:selectedIds", next);
}

function toggleOne(id: string): void {
  const next = new Set(props.selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  emit("update:selectedIds", next);
}

function pageRange(): { from: number; to: number } {
  const from = props.pageTotal === 0 ? 0 : (props.page - 1) * props.pageSize + 1;
  const to = Math.min(props.page * props.pageSize, props.pageTotal);
  return { from, to };
}
</script>

<template>
  <section class="workspace-page proxy-workspace">
    <header class="page-heading page-heading-actions">
      <div>
        <p class="section-kicker">出口资源</p>
        <h1>代理池</h1>
        <p>活跃代理可被授权服务领取用于铸票，也用于转发上游请求。带认证的 SOCKS 代理无法驱动浏览器，不参与铸票。</p>
      </div>
      <div class="page-actions">
        <button class="button button-quiet" type="button" :disabled="checking" :aria-busy="checking" @click="emit('checkScope', 'pending')">
          <span v-if="checking" class="spinner" aria-hidden="true"></span>
          <AppIcon v-else name="refresh-cw" :size="14" />{{ checking ? "测活中" : "测活待测活" }}
        </button>
        <button class="button button-quiet" type="button" :disabled="checking" @click="emit('checkScope', 'unavailable')">
          <AppIcon name="alert-circle" :size="14" />重测不可用
        </button>
        <button class="button button-quiet" type="button" :disabled="checking" @click="emit('checkScope', 'all')">
          <AppIcon name="activity" :size="14" />测活全部
        </button>
      </div>
    </header>

    <div class="resource-summary" role="group" aria-label="代理状态筛选">
      <button
        v-for="item in filters"
        :key="item.id"
        type="button"
        :class="{ active: filter === item.id }"
        :aria-pressed="filter === item.id"
        @click="emit('update:filter', item.id)"
      >
        <strong>{{ item.count }}</strong><span>{{ item.label }}</span>
      </button>
    </div>

    <AppDisclosure
      :open="importOpen"
      title="批量导入代理"
      description="每行一条，支持 host:port、host:port:user:pass、user:pass@host:port 或完整 URL。"
      open-label="导入"
      @update:open="importOpen = $event"
    >
      <div class="configuration-body">
        <div class="stacked-field">
          <label for="proxy-import">代理清单</label>
          <textarea
            id="proxy-import"
            :value="importText"
            placeholder="1.2.3.4:8080&#10;5.6.7.8:1080:user:pass&#10;socks5://9.9.9.9:1080"
            @input="emit('update:importText', ($event.target as HTMLTextAreaElement).value)"
          ></textarea>
          <small>以 # 开头的行会被忽略。导入后状态为「待测活」，由后台测活器决定是否转为活跃。</small>
        </div>
        <div class="field-grid">
          <label>
            <span>缺省协议</span>
            <select :value="importProtocol" @change="emit('update:importProtocol', ($event.target as HTMLSelectElement).value as ProxyKind)">
              <option v-for="protocol in protocols" :key="protocol" :value="protocol">{{ protocol }}</option>
            </select>
            <small>仅作用于没写 scheme 的简写行。</small>
          </label>
        </div>
        <div class="form-actions">
          <button class="button button-primary" type="button" :disabled="importing || !importText.trim()" :aria-busy="importing" @click="emit('import')">
            <span v-if="importing" class="spinner" aria-hidden="true"></span>
            <AppIcon v-else name="plus" :size="14" />{{ importing ? "导入中" : "导入" }}
          </button>
        </div>
        <div v-if="importSummary" class="field-hint">
          新增 {{ importSummary.imported }} · 重复 {{ importSummary.duplicates }} · 无效 {{ importSummary.invalid.length }}
        </div>
        <ul v-if="importSummary?.invalid.length" class="action-list">
          <li v-for="entry in importSummary.invalid" :key="entry.line" class="tone-bad">
            <span class="action-indicator" aria-hidden="true"></span>
            <div><strong class="mono">{{ entry.line }}</strong><p>{{ entry.message }}</p></div>
          </li>
        </ul>
      </div>
    </AppDisclosure>

    <section class="content-section">
      <div class="section-heading">
        <div><h2>代理列表</h2><p>每页 {{ pageSize }} 条，URL 已掩码，凭证不会离开服务端。</p></div>
        <div class="table-toolbar">
          <span v-if="selectedIds.size > 0" class="selection-count">已选 {{ selectedIds.size }} 个</span>
          <button class="button button-quiet" type="button" :disabled="checking || selectedIds.size === 0" @click="emit('checkSelected')">
            <AppIcon name="refresh-cw" :size="14" />测活所选
          </button>
          <button class="button button-danger" type="button" :disabled="removing || selectedIds.size === 0" @click="emit('deleteSelected')">
            <span v-if="removing" class="spinner" aria-hidden="true"></span>
            <AppIcon v-else name="trash-2" :size="14" />删除所选
          </button>
          <label class="page-size-label">
            每页
            <select :value="pageSize" @change="emit('update:pageSize', Number(($event.target as HTMLSelectElement).value))">
              <option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
            </select>
          </label>
        </div>
      </div>

      <div v-if="proxies.length === 0" class="workspace-empty">
        <strong>没有匹配的代理</strong>
        <p>导入代理后，后台测活器会在下一个周期内探测它们。</p>
      </div>

      <div v-else class="proxy-table">
        <div class="proxy-table-head">
          <label class="cell-cell" :class="{ checked: allPageSelected }">
            <input
              type="checkbox"
              :checked="allPageSelected"
              aria-label="勾选本页全部"
              @change="toggleAll()"
            />
          </label>
          <span>状态</span>
          <span>代理地址</span>
          <span>协议</span>
          <span>延迟</span>
          <span>速度</span>
          <span>凭证</span>
          <span>失败</span>
          <span>最近使用</span>
          <span>原因</span>
          <span>操作</span>
        </div>
        <div
          v-for="proxy in proxies"
          :key="proxy.id"
          class="proxy-table-row"
          :class="{ selected: selectedIds.has(proxy.id) }"
        >
          <label class="cell-cell">
            <input
              type="checkbox"
              :checked="selectedIds.has(proxy.id)"
              :aria-label="`勾选 ${proxy.maskedUrl}`"
              @change="toggleOne(proxy.id)"
            />
          </label>
          <span class="cell-status">
            <span class="table-status" :class="proxy.status" aria-hidden="true"></span>
            {{ PROXY_STATUS_LABEL[proxy.status] }}
          </span>
          <span class="cell-url">
            <code>{{ proxy.maskedUrl }}</code>
            <span v-if="proxy.leased" class="badge muted">已领取</span>
            <span v-if="proxy.rateLimitedUntil" class="badge" :class="proxy.cooldownReason === 'ip_blocked' ? 'bad' : 'warn'">
              {{ proxy.cooldownReason === "ip_blocked" ? "403 封禁" : "429 冷却" }}
            </span>
            <span v-if="!proxy.mintable" class="badge warn">不可铸票</span>
          </span>
          <span class="mono" data-label="协议">{{ proxy.kind }}</span>
          <span class="mono" data-label="延迟">{{ formatLatency(proxy.latencyMs) }}</span>
          <span class="mono" data-label="速度">{{ formatSpeed(proxy.throughputBps) }}</span>
          <span class="mono" data-label="可用凭证">{{ proxy.availableTickets }}</span>
          <span class="mono" data-label="失败次数">{{ proxy.failureCount }}</span>
          <span class="muted" data-label="最近使用">{{ formatRelative(proxy.lastUsedAt, now) }}</span>
          <span v-if="proxy.rejectReason" class="cell-reject" data-label="原因">{{ proxy.rejectReason }}</span>
          <span class="cell-actions">
            <button class="text-button" type="button" :disabled="busyIds.has(proxy.id)" :aria-busy="busyIds.has(proxy.id)" @click="emit('check', proxy)">
              <span v-if="busyIds.has(proxy.id)" class="spinner" aria-hidden="true"></span>
              <AppIcon v-else name="refresh-cw" :size="13" />测活
            </button>
            <button
              v-if="proxy.status === 'unavailable'"
              class="text-button"
              type="button"
              :disabled="busyIds.has(proxy.id)"
              @click="emit('reactivate', proxy)"
            >
              <AppIcon name="check-circle" :size="13" />启用
            </button>
            <button class="text-button danger" type="button" :disabled="busyIds.has(proxy.id)" @click="emit('delete', proxy)">
              <AppIcon name="trash-2" :size="13" />删除
            </button>
          </span>
        </div>
      </div>

      <div v-if="proxies.length > 0" class="pagination-bar">
        <span class="muted">第 {{ pageRange().from }}–{{ pageRange().to }} 条，共 {{ pageTotal }} 条</span>
        <div class="pagination-buttons">
          <button class="button button-quiet" type="button" :disabled="page <= 1" @click="emit('update:page', page - 1)">
            <AppIcon name="chevron-left" :size="14" />上一页
          </button>
          <span class="page-indicator">{{ page }} / {{ pageCount }}</span>
          <button class="button button-quiet" type="button" :disabled="page >= pageCount" @click="emit('update:page', page + 1)">
            下一页<AppIcon name="chevron-right" :size="14" />
          </button>
        </div>
      </div>
    </section>
  </section>
</template>