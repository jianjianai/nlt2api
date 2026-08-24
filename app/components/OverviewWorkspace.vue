<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import type {
  AccountOverview,
  AnalyticsGranularity,
  AnalyticsOverview,
  AnalyticsQueryResult,
  AnalyticsSort,
  EgressRuntime,
  ProxyPoolEntry,
} from "../types/admin.ts";
import type { OverviewSnapshot } from "../utils/admin-ui.ts";
import {
  confidenceLabel,
  forecastConstraintLabel,
  formatMicroUsd,
  signedPercent,
} from "../utils/admin-ui.ts";

const props = defineProps<{
  snapshot: OverviewSnapshot;
  analytics: AnalyticsOverview | null;
  detail: AnalyticsQueryResult | null;
  analyticsRange: "today" | "month" | "custom";
  analyticsGranularity: AnalyticsGranularity;
  analyticsSort: AnalyticsSort;
  analyticsModel: string;
  customFrom: string;
  customTo: string;
  loadingAnalytics: boolean;
  accountOverview: AccountOverview;
  proxies: ProxyPoolEntry[];
  egresses: EgressRuntime[];
}>();
const emit = defineEmits<{
  navigate: [workspace: "accounts" | "proxies" | "scheduler" | "settings", targetId?: string];
  setRange: [value: "today" | "month" | "custom"];
  setGranularity: [value: AnalyticsGranularity];
  setSort: [value: AnalyticsSort];
  setModel: [value: string];
  "update:customFrom": [value: string];
  "update:customTo": [value: string];
  loadCustom: [];
}>();

const activeAnalysis = ref<"capacity" | "cost" | "models">("capacity");
const recommendation = computed(() => props.analytics?.recommendation);
const chartPoints = computed(() => {
  const values = props.analytics?.series.map((point) => point.upstreamAttempts) ?? [];
  if (values.length === 0) return "";
  const max = Math.max(1, ...values);
  const denominator = Math.max(1, values.length - 1);
  return values.map((value, index) => `${(index / denominator) * 100},${32 - (value / max) * 28}`).join(" ");
});
const utilization = computed(() => Math.max(0, Math.min(1, props.analytics?.utilization ?? 0)));
const pricedCoverageLabel = computed(() => `${Math.round((props.analytics?.pricedCoverage ?? 0) * 100)}% 已定价`);
const displayedModels = computed(() => props.detail?.models ?? props.analytics?.models ?? []);
const modelOptions = computed(() => [...new Set([
  ...(props.analytics?.models.map((item) => item.model) ?? []),
  ...(props.detail?.models.map((item) => item.model) ?? []),
])].sort());
const totalTokens = (row: { promptTokens: number; completionTokens: number }) => row.promptTokens + row.completionTokens;
const dateLabel = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未开始";
const priceSourceLabel = (value?: "vendor_official" | "portal_catalog") => value === "vendor_official" ? "厂商官方" : value === "portal_catalog" ? "门户目录" : "未定价";
</script>

<template>
  <section class="workspace-page overview-workspace">
    <header class="page-heading">
      <div><p class="section-kicker">运行状态</p><h1>运行概览</h1><p>实时负载、容量预测、模型消费与运行异常。</p></div>
      <span v-if="analytics" class="analytics-live" :class="analytics.health"><i></i>{{ analytics.health === "healthy" ? "分析正常" : "分析降级" }}</span>
    </header>

    <div class="overview-metrics" aria-label="运行指标">
      <article v-for="metric in snapshot.metrics" :key="metric.id" :class="`tone-${metric.tone}`">
        <span>{{ metric.label }}</span>
        <strong>{{ metric.value }}</strong>
        <small>{{ metric.detail }}</small>
      </article>
    </div>
    <section class="content-section action-section">
      <div class="section-heading"><div><h2>需要处理</h2><p>仅显示当前状态中可以直接处理的问题。</p></div><span class="section-count">{{ snapshot.actions.length }}</span></div>
      <div v-if="snapshot.actions.length === 0" class="status-empty"><span aria-hidden="true"><AppIcon name="check" :size="14" /></span><div><strong>当前没有需要处理的异常</strong><p>账号、代理和队列状态均正常。</p></div></div>
      <ul v-else class="action-list"><li v-for="item in snapshot.actions" :key="item.id" :class="`tone-${item.tone}`"><span class="action-indicator" aria-hidden="true"></span><div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p></div><button class="button button-quiet" type="button" @click="emit('navigate', item.workspace, item.accountId || item.proxyId)">{{ item.actionLabel }}<AppIcon name="arrow-right" :size="13" /></button></li></ul>
    </section>

    <section v-if="analytics" class="analytics-spotlight" aria-labelledby="rpm-title">
      <div class="rpm-spotlight">
        <div class="rpm-number"><strong>{{ analytics.upstreamRpm }}</strong><span id="rpm-title">总 RPM</span></div>
        <div class="rpm-trend-copy">
          <strong>{{ signedPercent(analytics.trend15m) }} · 15 分钟趋势</strong>
          <span>客户端 {{ analytics.clientRpm }} RPM · 上游调用放大 {{ analytics.amplification.toFixed(2) }}×</span>
          <svg class="rpm-chart" viewBox="0 0 100 34" role="img" :aria-label="`最近 ${analytics.series.length} 分钟上游 RPM 趋势`" preserveAspectRatio="none">
            <line x1="0" y1="32" x2="100" y2="32" />
            <polyline v-if="chartPoints" :points="chartPoints" />
          </svg>
        </div>
      </div>
      <div class="analytics-quick-metrics">
        <article :class="{ warn: utilization >= .8 }"><span>容量使用率</span><strong>{{ Math.round(utilization * 100) }}%</strong><small>{{ utilization >= .8 ? "接近安全阈值" : "当前容量可用" }}</small></article>
        <article><span>今日消费</span><strong>{{ formatMicroUsd(analytics.todayCostMicroUsd) }}</strong><small>{{ pricedCoverageLabel }}</small></article>
        <article :class="{ warn: (recommendation?.recommendedAccounts ?? 0) > 0 }"><span>{{ recommendation?.bindingConstraint === "shared_egress_rpm" ? "出口建议" : "建议账号" }}</span><strong>{{ recommendation?.bindingConstraint === "shared_egress_rpm" ? "新增出口" : `+${recommendation?.recommendedAccounts ?? 0}` }}</strong><small>{{ recommendation?.model || "暂无压力模型" }}</small></article>
        <article><span>本月消费</span><strong>{{ formatMicroUsd(analytics.monthCostMicroUsd) }}</strong><small>精确账本</small></article>
      </div>
    </section>

    <section v-else class="analytics-empty" aria-live="polite"><span class="spinner" aria-hidden="true"></span><div><strong>正在初始化分析账本</strong><p>账号与调度状态仍可正常使用。</p></div></section>

    <section v-if="analytics?.health === 'degraded'" class="analytics-notice bad" role="status"><AppIcon name="alert-triangle" :size="16" /><div><strong>分析数据暂时降级</strong><p>{{ analytics.error || "网关请求不受影响，系统将继续尝试恢复分析服务。" }}</p></div></section>

    <section v-if="analytics" class="forecast-callout" :class="recommendation?.bindingConstraint === 'shared_egress_rpm' ? 'egress' : ''">
      <div class="forecast-count"><span v-if="recommendation?.bindingConstraint === 'shared_egress_rpm'">出口</span><strong v-else>+{{ recommendation?.recommendedAccounts ?? 0 }}</strong></div>
      <div class="forecast-copy">
        <strong v-if="recommendation?.bindingConstraint === 'shared_egress_rpm'">建议先新增独立出口</strong>
        <strong v-else-if="recommendation?.bindingConstraint === 'no_healthy_account'">缺少可用扩容账号模板</strong>
        <strong v-else-if="recommendation?.stabilizing && recommendation.recommendedAccounts === 0">扩容趋势确认中</strong>
        <strong v-else-if="recommendation?.stabilizing">容量恢复确认中</strong>
        <strong v-else-if="recommendation?.recommendedAccounts">建议扩容 {{ recommendation.model }} 账号</strong>
        <strong v-else-if="recommendation?.confidence === 'low'">容量预测正在积累样本</strong>
        <strong v-else>当前账号容量充足</strong>
        <p v-if="recommendation">预测 {{ recommendation.forecastRpm.toFixed(1) }} RPM · 有效容量 {{ recommendation.effectiveCapacityRpm.toFixed(1) }} RPM · 主瓶颈 {{ forecastConstraintLabel(recommendation.bindingConstraint) }}</p>
        <p v-else>暂无模型需求样本；完成请求后将自动生成预测。</p>
      </div>
      <div v-if="recommendation" class="forecast-meta"><span>{{ recommendation.stabilizing ? "稳定性观察" : confidenceLabel(recommendation.confidence) }}</span><small>{{ recommendation.sampleMinutes }} 分钟样本 · {{ Math.round(recommendation.safetyMargin * 100) }}% 余量</small></div>
    </section>

    <section v-if="analytics" class="content-section analytics-workbench">
      <div class="section-heading analytics-heading">
        <div><h2>容量与消费分析</h2><p>切换视图不会隐藏顶部实时负载与扩容结论。</p></div>
        <div class="segmented-control analytics-tabs" role="group" aria-label="分析视图">
          <button type="button" :aria-pressed="activeAnalysis === 'capacity'" :data-state="activeAnalysis === 'capacity' ? 'active' : 'inactive'" @click="activeAnalysis = 'capacity'">容量预测</button>
          <button type="button" :aria-pressed="activeAnalysis === 'cost'" :data-state="activeAnalysis === 'cost' ? 'active' : 'inactive'" @click="activeAnalysis = 'cost'">消费分析</button>
          <button type="button" :aria-pressed="activeAnalysis === 'models'" :data-state="activeAnalysis === 'models' ? 'active' : 'inactive'" @click="activeAnalysis = 'models'">模型利用率</button>
        </div>
      </div>

      <div v-if="activeAnalysis === 'capacity'" class="capacity-analysis">
        <div v-if="recommendation" class="capacity-evidence">
          <div><span>预测需求</span><strong>{{ recommendation.forecastRpm.toFixed(1) }} RPM</strong></div>
          <div><span>有效容量</span><strong>{{ recommendation.effectiveCapacityRpm.toFixed(1) }} RPM</strong></div>
          <div><span>P95 服务时长</span><strong>{{ Math.round(recommendation.p95DurationMs / 100) / 10 }} 秒</strong></div>
          <div><span>P95 调用放大</span><strong>{{ recommendation.p95Amplification.toFixed(2) }}×</strong></div>
          <div><span>主瓶颈</span><strong>{{ forecastConstraintLabel(recommendation.bindingConstraint) }}</strong></div>
          <div><span>样本覆盖</span><strong>{{ recommendation.sampleMinutes }} 分钟</strong></div>
        </div>
        <div v-else class="mini-empty">完成首批模型请求后，将显示 5/15/60 分钟需求、P95 时长和扩容依据。</div>
        <div v-if="analytics.anomalies.length" class="analytics-anomalies"><p v-for="item in analytics.anomalies" :key="item"><AppIcon name="alert-circle" :size="13" />{{ item }}</p></div>
      </div>

      <div v-else-if="activeAnalysis === 'cost'" class="cost-analysis">
        <div class="analytics-range-bar">
          <div class="segmented-control" role="group" aria-label="消费时间范围">
            <button v-for="item in [{ id: 'today', label: '今日' }, { id: 'month', label: '本月' }, { id: 'custom', label: '自定义' }]" :key="item.id" type="button" :aria-pressed="analyticsRange === item.id" :data-state="analyticsRange === item.id ? 'active' : 'inactive'" @click="emit('setRange', item.id as 'today' | 'month' | 'custom')">{{ item.label }}</button>
          </div>
          <div class="analytics-query-controls">
            <label>模型筛选<select :value="analyticsModel" @change="emit('setModel', ($event.target as HTMLSelectElement).value)"><option value="">全部模型</option><option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option></select></label>
            <label>趋势粒度<select :value="analyticsGranularity" @change="emit('setGranularity', ($event.target as HTMLSelectElement).value as AnalyticsGranularity)"><option value="minute">每分钟</option><option value="5m">每 5 分钟</option><option value="hour">每小时</option><option value="day">每天</option></select></label>
            <label>模型排序<select :value="analyticsSort" @change="emit('setSort', ($event.target as HTMLSelectElement).value as AnalyticsSort)"><option value="cost">消费</option><option value="utilization">利用率</option><option value="rpm">RPM</option><option value="tokens">Tokens</option></select></label>
          </div>
          <div v-if="analyticsRange === 'custom'" class="custom-range"><label>开始日期<input type="date" :value="customFrom" @input="emit('update:customFrom', ($event.target as HTMLInputElement).value)" /></label><label>结束日期<input type="date" :value="customTo" @input="emit('update:customTo', ($event.target as HTMLInputElement).value)" /></label><button class="button button-primary" type="button" :disabled="loadingAnalytics" @click="emit('loadCustom')">查询</button></div>
        </div>
        <div v-if="loadingAnalytics" class="analytics-empty compact"><span class="spinner" aria-hidden="true"></span><strong>正在加载消费明细</strong></div>
        <template v-else-if="detail">
          <div class="cost-breakdown">
            <div><span>总消费</span><strong>{{ formatMicroUsd(detail.totalCostMicroUsd) }}</strong></div>
            <div><span>普通输入</span><strong>{{ formatMicroUsd(detail.inputCostMicroUsd) }}</strong></div>
            <div><span>缓存输入</span><strong>{{ formatMicroUsd(detail.cachedInputCostMicroUsd) }}</strong></div>
            <div><span>输出</span><strong>{{ formatMicroUsd(detail.outputCostMicroUsd) }}</strong></div>
          </div>
          <p class="analytics-footnote">精确账本始于 {{ dateLabel(analytics.ledgerStartedAt) }}。价格目录状态：{{ analytics.priceStatus === "current" ? "最新" : analytics.priceStatus === "stale" ? "已陈旧" : "不可用" }}；未定价请求 {{ detail.unpricedRequests }} 个，不计入已定价总消费。</p>
        </template>        <div v-else class="mini-empty">选择时间范围后加载消费拆分。</div>
      </div>

      <div v-else class="model-analysis">
        <div v-if="displayedModels.length" class="analytics-model-table" role="table" aria-label="模型利用率">
          <div class="analytics-model-head" role="row"><span role="columnheader">模型</span><span role="columnheader">客户端 / 上游 RPM</span><span role="columnheader">放大率</span><span role="columnheader">24h 消费</span><span role="columnheader">利用率</span><span role="columnheader">建议</span></div>
          <div v-for="model in displayedModels" :key="model.model" class="analytics-model-row" role="row">
            <code role="cell" :title="model.model">{{ model.model }}</code><span role="cell" data-label="客户端 / 上游 RPM">{{ model.clientRpm }} / {{ model.upstreamRpm }}</span><span role="cell" data-label="调用放大">{{ model.amplification.toFixed(2) }}×</span><span role="cell" data-label="消费">{{ formatMicroUsd(model.totalCostMicroUsd) }}</span><span role="cell" data-label="利用率"><b class="utilization-bar"><i :style="{ width: `${Math.min(100, Math.round(model.utilization * 100))}%` }"></i></b>{{ Math.round(model.utilization * 100) }}%</span><span role="cell" data-label="建议">{{ model.recommendedAccounts ? `+${model.recommendedAccounts} 账号` : forecastConstraintLabel(model.bindingConstraint) }}</span>
            <small>{{ totalTokens(model).toLocaleString() }} tokens · 输入 {{ formatMicroUsd(model.inputCostMicroUsd) }} · 缓存 {{ formatMicroUsd(model.cachedInputCostMicroUsd) }} · 输出 {{ formatMicroUsd(model.outputCostMicroUsd) }} · 当前价源 {{ priceSourceLabel(model.priceSource) }}<template v-if="model.priceVerifiedAt">（核验 {{ dateLabel(model.priceVerifiedAt) }}）</template> · {{ confidenceLabel(model.confidence) }}</small>
          </div>
        </div>
        <div v-else class="mini-empty">暂无单模型精确用量。</div>
      </div>
    </section>

    <div class="overview-columns">
      <section class="content-section"><div class="section-heading"><div><h2>账号负载</h2><p>账号 RPM、模型在途和出口摘要。</p></div><button class="inline-action" type="button" @click="emit('navigate', 'accounts')">管理账号<AppIcon name="arrow-right" :size="12" /></button></div><div v-if="accountOverview.rows.length" class="overview-table" role="table" aria-label="账号负载"><div v-for="account in accountOverview.rows" :key="account.id" class="overview-row" role="row"><div role="cell"><strong>{{ account.label }}</strong><span>{{ account.proxy ? (account.proxyPoolEntryId ? "代理池出口" : "自定义代理") : "直连" }}</span></div><span role="cell">{{ account.requestsLastMinute }} / {{ account.accountRpm ?? "全局" }} RPM</span><span role="cell">{{ account.inFlight }} 个在途</span></div></div><div v-else class="mini-empty">暂无账号。</div></section>
      <section class="content-section"><div class="section-heading"><div><h2>出口运行</h2><p>调度器当前识别的出口组。</p></div><button class="inline-action" type="button" @click="emit('navigate', 'scheduler')">打开调度<AppIcon name="arrow-right" :size="12" /></button></div><div v-if="egresses.length" class="overview-table" role="table" aria-label="出口运行"><div v-for="egress in egresses.slice(0, 6)" :key="egress.id" class="overview-row" role="row"><div role="cell"><strong class="mono">{{ egress.id }}</strong><span>{{ egress.accountCount }} 个账号</span></div><span role="cell">{{ egress.requestsLastMinute }} / {{ egress.rpm }} RPM</span><span role="cell">{{ egress.limited ? "受限流控制" : "未限流" }}</span></div></div><div v-else class="mini-empty">暂无出口运行数据。</div></section>
    </div>
  </section>
</template>
