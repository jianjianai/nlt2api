<script setup lang="ts">
import type { Account, EgressRuntime, ProxyPoolEntry } from "../types/admin.ts";
import type { OverviewSnapshot } from "../utils/admin-ui.ts";

const props = defineProps<{
  snapshot: OverviewSnapshot;
  accounts: Account[];
  proxies: ProxyPoolEntry[];
  egresses: EgressRuntime[];
}>();
const emit = defineEmits<{ navigate: [workspace: "accounts" | "proxies" | "scheduler" | "settings", targetId?: string] }>();

const metricTone = (tone: string) => `tone-${tone}`;
</script>

<template>
  <section class="workspace-page overview-workspace">
    <header class="page-heading"><div><p class="section-kicker">运行状态</p><h1>运行概览</h1><p>账号、代理和调度队列的当前状态。</p></div></header>
    <div class="overview-metrics" aria-label="运行指标">
      <article v-for="metric in snapshot.metrics" :key="metric.id" :class="metricTone(metric.tone)"><span>{{ metric.label }}</span><strong>{{ metric.value }}</strong><small>{{ metric.detail }}</small></article>
    </div>

    <section class="content-section action-section">
      <div class="section-heading"><div><h2>需要处理</h2><p>仅显示当前状态中可以直接处理的问题。</p></div><span class="section-count">{{ snapshot.actions.length }}</span></div>
      <div v-if="snapshot.actions.length === 0" class="status-empty"><span aria-hidden="true">✓</span><div><strong>当前没有需要处理的异常</strong><p>账号、代理和队列状态均正常。</p></div></div>
      <ul v-else class="action-list">
        <li v-for="item in snapshot.actions" :key="item.id" :class="`tone-${item.tone}`"><span class="action-indicator" aria-hidden="true"></span><div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p></div><button class="button button-quiet" type="button" @click="emit('navigate', item.workspace, item.accountId || item.proxyId)">{{ item.actionLabel }}</button></li>
      </ul>
    </section>

    <div class="overview-columns">
      <section class="content-section"><div class="section-heading"><div><h2>账号负载</h2><p>账号 RPM、模型在途和出口摘要。</p></div><button class="inline-action" type="button" @click="emit('navigate', 'accounts')">管理账号</button></div><div v-if="accounts.length" class="overview-table"><div v-for="account in accounts.slice(0, 6)" :key="account.id" class="overview-row"><div><strong>{{ account.label }}</strong><span>{{ account.proxy ? (account.proxyPoolEntryId ? "代理池出口" : "自定义代理") : "直连" }}</span></div><span>{{ account.runtime.requestsLastMinute }} / {{ account.schedulerOverrides?.accountRpm ?? "全局" }} RPM</span><span>{{ account.runtime.inFlight }} 个在途</span></div></div><div v-else class="mini-empty">暂无账号。</div></section>
      <section class="content-section"><div class="section-heading"><div><h2>出口运行</h2><p>调度器当前识别的出口组。</p></div><button class="inline-action" type="button" @click="emit('navigate', 'scheduler')">打开调度</button></div><div v-if="egresses.length" class="overview-table"><div v-for="egress in egresses.slice(0, 6)" :key="egress.id" class="overview-row"><div><strong class="mono">{{ egress.id }}</strong><span>{{ egress.accountCount }} 个账号</span></div><span>{{ egress.requestsLastMinute }} / {{ egress.rpm }} RPM</span><span>{{ egress.limited ? "受限流控制" : "未限流" }}</span></div></div><div v-else class="mini-empty">暂无出口运行数据。</div></section>
    </div>
  </section>
</template>
