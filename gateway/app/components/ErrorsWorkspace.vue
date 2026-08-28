<script setup lang="ts">
import { computed, ref } from "vue";
import AppDialog from "./ui/AppDialog.vue";
import AppIcon from "./ui/AppIcon.vue";
import type { ErrorLogEntry, ErrorLogKind, ErrorLogStatus } from "../types/admin.ts";
import { ERROR_KIND_LABEL, ERROR_KIND_TONE, ERROR_STATUS_LABEL, formatRelative, formatTime } from "../utils/admin-ui.ts";

const props = defineProps<{
  entries: ErrorLogEntry[];
  total: number;
  summary: Record<ErrorLogKind, Record<ErrorLogStatus, number>> | null;
  kind: ErrorLogKind | "all";
  status: ErrorLogStatus | "all";
  sessionId: string;
  page: number;
  pageSize: number;
  clearing: boolean;
  now: number;
}>();

const emit = defineEmits<{
  "update:kind": [value: ErrorLogKind | "all"];
  "update:status": [value: ErrorLogStatus | "all"];
  "update:sessionId": [value: string];
  "update:page": [value: number];
  "update:pageSize": [value: number];
  clearOlder: [];
  clearAll: [];
}>();

const selected = ref<ErrorLogEntry | null>(null);
const detailOpen = ref(false);

function openDetail(entry: ErrorLogEntry): void {
  selected.value = entry;
  detailOpen.value = true;
}

function closeDetail(open: boolean): void {
  detailOpen.value = open;
  if (!open) selected.value = null;
}

const kinds = computed<Array<{ id: ErrorLogKind | "all"; label: string; count: number }>>(() => {
  const summary = props.summary;
  const count = (kind: ErrorLogKind) => {
    if (!summary) return 0;
    const statuses = summary[kind];
    return statuses.failed + statuses.rejected;
  };
  return [
    { id: "all" as const, label: "全部", count: props.total },
    { id: "minter" as const, label: ERROR_KIND_LABEL.minter, count: count("minter") },
    { id: "forward" as const, label: ERROR_KIND_LABEL.forward, count: count("forward") },
  ];
});

const statuses = computed<Array<{ id: ErrorLogStatus | "all"; label: string }>>(() => [
  { id: "all", label: "全部状态" },
  { id: "failed", label: ERROR_STATUS_LABEL.failed },
  { id: "rejected", label: ERROR_STATUS_LABEL.rejected },
]);

const pageSizes = [20, 50, 100, 200];
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const entries = computed(() => props.entries.filter((entry) => (
  (props.kind === "all" || entry.kind === props.kind)
  && (props.status === "all" || entry.status === props.status)
)));

function pageRange(): { from: number; to: number } {
  const from = props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1;
  const to = Math.min(props.page * props.pageSize, props.total);
  return { from, to };
}

function clearQuery(): void {
  if (props.sessionId) emit("update:sessionId", "");
  if (props.kind !== "all") emit("update:kind", "all");
  if (props.status !== "all") emit("update:status", "all");
}
</script>

<template>
  <section class="workspace-page">
    <header class="page-heading page-heading-actions">
      <div>
        <p class="section-kicker">运行记录</p>
        <h1>错误记录</h1>
        <p>铸票与转发失败都会写入此日志，保留 7 天；代理 URL 与凭证在写入前脱敏。</p>
      </div>
      <div class="page-actions">
        <button class="button button-quiet" type="button" :disabled="clearing || total === 0" @click="emit('clearOlder')">
          <AppIcon name="trash-2" :size="14" />清除 24 小时前
        </button>
        <button class="button button-danger" type="button" :disabled="clearing || total === 0" :aria-busy="clearing" @click="emit('clearAll')">
          <span v-if="clearing" class="spinner" aria-hidden="true"></span>
          <AppIcon v-else name="trash-2" :size="14" />清空全部
        </button>
      </div>
    </header>

    <div class="resource-summary" role="group" aria-label="错误分类筛选">
      <button
        v-for="item in kinds"
        :key="item.id"
        type="button"
        :class="{ active: kind === item.id }"
        :aria-pressed="kind === item.id"
        @click="emit('update:kind', item.id)"
      >
        <strong>{{ item.count }}</strong><span>{{ item.label }}</span>
      </button>
    </div>

    <section class="content-section">
      <div class="section-heading">
        <div><h2>错误明细</h2><p>按时间倒序；每条记录归属本次运行的关键链路，便于定位故障来源。</p></div>
        <div class="table-toolbar">
          <label class="page-size-label">
            每页
            <select :value="pageSize" @change="emit('update:pageSize', Number(($event.target as HTMLSelectElement).value))">
              <option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
            </select>
          </label>
        </div>
      </div>

      <div class="filter-bar">
        <label>
          状态
          <select :value="status" @change="emit('update:status', ($event.target as HTMLSelectElement).value as ErrorLogStatus | 'all')">
            <option v-for="item in statuses" :key="item.id" :value="item.id">{{ item.label }}</option>
          </select>
        </label>
        <label>
          会话 ID
          <input
            :value="sessionId"
            placeholder="按会话精确筛选"
            spellcheck="false"
            @input="emit('update:sessionId', ($event.target as HTMLInputElement).value.trim())"
          />
        </label>
        <button v-if="sessionId || kind !== 'all' || status !== 'all'" class="text-button" type="button" @click="clearQuery">清除筛选</button>
      </div>

      <div v-if="entries.length === 0" class="workspace-empty">
        <strong>{{ total === 0 ? "暂无错误记录" : "没有匹配的记录" }}</strong>
        <p v-if="total === 0">系统运行正常时此列表保持为空；铸票失败与转发失败会自动记录。</p>
        <p v-else>调整筛选条件后重试。</p>
      </div>

      <div v-else class="errors-table">
        <div class="errors-table-head">
          <span>时间</span>
          <span>来源</span>
          <span>状态</span>
          <span>详情</span>
          <span>归属</span>
        </div>
        <div
          v-for="entry in entries"
          :key="entry.id"
          class="errors-table-row"
          :class="{ clickable: entry.upstreamStatus !== undefined || entry.upstreamBody }"
          :role="entry.upstreamStatus !== undefined || entry.upstreamBody ? 'button' : undefined"
          :tabindex="entry.upstreamStatus !== undefined || entry.upstreamBody ? 0 : undefined"
          @click="openDetail(entry)"
          @keydown.enter.prevent="openDetail(entry)"
          @keydown.space.prevent="openDetail(entry)"
        >
          <span class="mono" data-label="时间">{{ formatTime(entry.at) }}</span>
          <span data-label="来源">
            <span class="badge" :class="ERROR_KIND_TONE[entry.kind]">{{ ERROR_KIND_LABEL[entry.kind] }}</span>
          </span>
          <span data-label="状态">
            <span class="badge" :class="entry.status === 'rejected' ? 'warn' : 'bad'">{{ ERROR_STATUS_LABEL[entry.status] }}</span>
            <span v-if="entry.attempt" class="muted">第 {{ entry.attempt }} 次尝试</span>
          </span>
          <span class="errors-message" data-label="详情">
            <code>{{ entry.message }}</code>
            <span v-if="entry.upstreamStatus !== undefined" class="muted mono">HTTP {{ entry.upstreamStatus }}</span>
            <span v-if="entry.agentId" class="muted mono">agent: {{ entry.agentId }}</span>
          </span>
          <span data-label="归属">
            <span v-if="entry.proxyId" class="muted mono">代理 {{ entry.proxyId.slice(0, 8) }}…</span>
            <span v-if="entry.sessionId" class="muted mono">会话 {{ entry.sessionId.slice(0, 8) }}…</span>
            <span v-if="!entry.proxyId && !entry.sessionId" class="muted">服务端</span>
          </span>
        </div>
      </div>

      <div v-if="entries.length > 0" class="pagination-bar">
        <span class="muted">第 {{ pageRange().from }}–{{ pageRange().to }} 条，共 {{ total }} 条 · 距今 {{ formatRelative(entries[0]!.at, now) }}</span>
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

    <AppDialog
      v-if="selected"
      :open="detailOpen"
      :title="`错误详情 #${selected.id}`"
      :description="`${ERROR_KIND_LABEL[selected.kind]} · ${ERROR_STATUS_LABEL[selected.status]} · ${formatTime(selected.at)}`"
      wide
      @update:open="closeDetail"
    >
      <div class="error-detail">
        <dl class="error-detail-meta">
          <div><dt>时间</dt><dd class="mono">{{ formatTime(selected.at) }}</dd></div>
          <div><dt>来源</dt><dd>{{ ERROR_KIND_LABEL[selected.kind] }}</dd></div>
          <div><dt>状态</dt><dd>{{ ERROR_STATUS_LABEL[selected.status] }}</dd></div>
          <div v-if="selected.attempt"><dt>第几次尝试</dt><dd>{{ selected.attempt }}</dd></div>
          <div v-if="selected.upstreamStatus !== undefined"><dt>上游状态码</dt><dd class="mono">HTTP {{ selected.upstreamStatus }}</dd></div>
          <div v-if="selected.proxyId"><dt>代理</dt><dd class="mono">{{ selected.proxyId }}</dd></div>
          <div v-if="selected.sessionId"><dt>会话</dt><dd class="mono">{{ selected.sessionId }}</dd></div>
          <div v-if="selected.agentId"><dt>Minter</dt><dd class="mono">{{ selected.agentId }}</dd></div>
        </dl>
        <div class="error-detail-block">
          <h3>错误消息</h3>
          <pre><code>{{ selected.message }}</code></pre>
        </div>
        <div v-if="selected.upstreamBody" class="error-detail-block">
          <h3>上游响应内容</h3>
          <pre><code>{{ selected.upstreamBody }}</code></pre>
        </div>
        <p v-else-if="selected.upstreamStatus !== undefined" class="muted">没有记录上游响应内容。</p>
      </div>
    </AppDialog>
  </section>
</template>