<script setup lang="ts">
import AppIcon from "./ui/AppIcon.vue";
import AppSwitch from "./ui/AppSwitch.vue";
import type { SchedulerRuntime, SchedulerSettings } from "../types/admin.ts";

const props = defineProps<{ draft: SchedulerSettings; runtime: SchedulerRuntime; saving: boolean }>();
const emit = defineEmits<{ updateField: [field: keyof SchedulerSettings, value: number | boolean]; save: [] }>();

function numberField(field: keyof SchedulerSettings, event: Event): void {
  emit("updateField", field, Number((event.target as HTMLInputElement).value));
}
</script>

<template>
  <section class="workspace-page scheduler-workspace">
    <header class="page-heading page-heading-actions"><div><p class="section-kicker">容量与排队</p><h1>调度策略</h1><p>控制账号、模型、出口和等待队列的统一准入容量。</p></div><button class="button button-primary" type="button" :disabled="saving" :aria-busy="saving" @click="emit('save')"><span v-if="saving" class="spinner" aria-hidden="true"></span><AppIcon v-else name="check" :size="14" />{{ saving ? "保存中" : "保存调度策略" }}</button></header>
    <div class="runtime-strip" aria-label="调度实时状态"><div :class="{ 'tone-warn': runtime.pending > 0 }"><span>排队请求</span><strong>{{ runtime.pending }}</strong><small>{{ runtime.pending > 0 ? "当前存在等待" : "队列畅通" }}</small></div><div :class="{ 'tone-warn': runtime.oldestWaitMs > 0 }"><span>最老等待</span><strong>{{ Math.ceil(runtime.oldestWaitMs / 1000) }} 秒</strong><small>{{ runtime.oldestWaitMs > 0 ? "最长排队时间" : "无等待请求" }}</small></div><div><span>出口组</span><strong>{{ runtime.egresses.length }}</strong><small>参与容量调度</small></div></div>

    <section class="content-section settings-group"><div class="section-heading"><div><h2>账号容量</h2><p>每个账号可承接的模型并发和一分钟请求数。</p></div></div><div class="field-grid"><label><span>账号模型并发</span><input :value="draft.accountModelConcurrency" type="number" min="1" max="1000" @change="numberField('accountModelConcurrency', $event)" /><small>同一账号的每个模型同时执行上限。</small></label><label><span>账号 RPM</span><input :value="draft.accountRpm" type="number" min="1" max="100000" @change="numberField('accountRpm', $event)" /><small>账号 60 秒滑动窗口的请求上限。</small></label></div></section>

    <section class="content-section settings-group"><div class="section-heading"><div><h2>出口容量</h2><p>相同规范化代理出口共享 RPM；直连限制可独立启用。</p></div></div><div class="field-grid"><label><span>代理 RPM</span><input :value="draft.proxyRpm" type="number" min="1" max="100000" @change="numberField('proxyRpm', $event)" /><small>同一代理主机和端口共享此限制。</small></label><label><span>直连出口 RPM</span><input :value="draft.directEgressRpm" type="number" min="1" max="100000" :disabled="!draft.directEgressLimitEnabled" @change="numberField('directEgressRpm', $event)" /><small>仅在启用直连出口限流时生效。</small></label><label class="toggle-field"><span><strong>限制直连出口</strong><small>开启后所有直连账号共享直连 RPM。</small></span><AppSwitch :model-value="draft.directEgressLimitEnabled" label="限制直连出口" @update:model-value="emit('updateField', 'directEgressLimitEnabled', $event)" /></label></div></section>

    <section class="content-section settings-group"><div class="section-heading"><div><h2>排队与粘性</h2><p>达到容量后请求进入事件驱动队列，并尽量保持原账号。</p></div></div><div class="field-grid"><label><span>最大排队秒数</span><input :value="draft.queueTimeoutSeconds" type="number" min="0" max="86400" @change="numberField('queueTimeoutSeconds', $event)" /><small>0 表示不设置调度器等待超时。</small></label><label><span>最大队列长度</span><input :value="draft.maxQueueSize" type="number" min="0" max="100000" @change="numberField('maxQueueSize', $event)" /><small>0 表示队列长度不设上限。</small></label><label><span>粘性有效期（秒）</span><input :value="draft.stickyTtlSeconds" type="number" min="1" max="604800" @change="numberField('stickyTtlSeconds', $event)" /><small>控制会话优先路由到原账号的持续时间。</small></label></div></section>

    <section class="content-section"><div class="section-heading"><div><h2>出口运行状态</h2><p>当前出口的账号数、RPM 和下一可用时间。</p></div></div><div v-if="runtime.egresses.length" class="egress-runtime-table" role="table" aria-label="出口运行状态"><div class="egress-runtime-head" role="row"><span role="columnheader">出口 ID</span><span role="columnheader">账号</span><span role="columnheader">请求 / RPM</span><span role="columnheader">限流</span><span role="columnheader">下一可用</span></div><div v-for="egress in runtime.egresses" :key="egress.id" class="egress-runtime-row" role="row"><code role="cell">{{ egress.id }}</code><span role="cell" data-label="账号">{{ egress.accountCount }}</span><span role="cell" data-label="请求 / RPM">{{ egress.requestsLastMinute }} / {{ egress.rpm }}</span><span role="cell" data-label="限流"><i class="table-status" :class="{ active: egress.limited }" aria-hidden="true"></i>{{ egress.limited ? "已启用" : "未启用" }}</span><span role="cell" data-label="下一可用">{{ egress.nextRateAvailableAt ? new Date(egress.nextRateAvailableAt).toLocaleTimeString() : "当前可用" }}</span></div></div><div v-else class="mini-empty">暂无出口运行数据。</div></section>
  </section>
</template>
