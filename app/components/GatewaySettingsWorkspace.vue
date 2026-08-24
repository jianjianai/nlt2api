<script setup lang="ts">
import { computed, ref } from "vue";
import AppDisclosure from "./ui/AppDisclosure.vue";
import AppIcon from "./ui/AppIcon.vue";
import SecretValue from "./ui/SecretValue.vue";
import type {
  AnalyticsOverview,
  AnalyticsRetention,
  GatewayConfig,
  GatewaySettings,
  PreambleVerbosity,
  ToolCallFormat,
} from "../types/admin.ts";

const props = defineProps<{
  settings: GatewaySettings;
  config: GatewayConfig;
  analytics: AnalyticsOverview | null;
  retention: AnalyticsRetention;
  cleanupCutoff: string;
  refreshingPrices: boolean;
  savingRetention: boolean;
  previewingCleanup: boolean;
  allModels: string[];
  minimumOutputTokensDraft: number;
  savingBudget: boolean;
  secretResetToken: number;
  copySecret: (value: string, label: string) => void | Promise<void>;
}>();
const emit = defineEmits<{
  "update:minimumOutputTokensDraft": [value: number];
  saveBudget: [];
  setToolFormat: [value: ToolCallFormat];
  setPreamble: [value: PreambleVerbosity];
  setModelToolFormat: [model: string, value: string];
  setModelPreamble: [model: string, value: string];
  refreshPrices: [];
  saveRetention: [value: AnalyticsRetention];
  "update:cleanupCutoff": [value: string];
  previewCleanup: [];
  signOut: [];
}>();

const overridesOpen = ref(false);
const formatOptions = [
  { value: "auto", label: "自动", description: "由模型选择 JSON 或 XML" },
  { value: "json", label: "JSON", description: "统一使用 JSON 信封" },
  { value: "xml", label: "XML", description: "统一使用 XML 信封" },
] as const;
const preambleOptions = [
  { value: "milestone", label: "里程碑" },
  { value: "normal", label: "关键步骤" },
  { value: "verbose", label: "逐步" },
  { value: "quiet", label: "静默" },
] as const;

const effectiveFormat = () => props.settings.toolCallFormat ?? props.config.toolCallFormat ?? "auto";
const effectivePreamble = () => props.settings.preambleVerbosity ?? props.config.preambleVerbosity ?? "milestone";
const overrideCount = computed(() => props.allModels.filter((model) =>
  Boolean(props.settings.modelToolCallFormats?.[model] || props.settings.modelPreambleVerbosities?.[model]),
).length);
const overrideSummary = computed(() => props.allModels.length
  ? `${props.allModels.length} 个模型 · ${overrideCount.value} 个自定义配置`
  : "暂无已配置模型；添加模型后可单独覆盖全局协议。",
);

function updateBudget(value: string): void {
  emit("update:minimumOutputTokensDraft", Number(value));
}

function modelHasOverride(model: string): boolean {
  return Boolean(props.settings.modelToolCallFormats?.[model] || props.settings.modelPreambleVerbosities?.[model]);
}

function retentionValue(value: number | null): string {
  return value === null ? "permanent" : String(value);
}

function updateRetention(field: keyof AnalyticsRetention, value: string): void {
  const parsed = value === "permanent" ? null : Number(value);
  emit("saveRetention", { ...props.retention, [field]: parsed });
}

function analyticsDate(value?: string): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未建立";
}
</script>

<template>
  <section class="workspace-page gateway-settings-workspace">
    <header class="page-heading">
      <div>
        <p class="section-kicker">全局配置</p>
        <h1>网关设置</h1>
        <p>集中管理访问凭据、生成预算和工具调用协议。</p>
      </div>
    </header>

    <div class="gateway-status-grid" aria-label="当前网关配置摘要">
      <article :class="{ active: config.clientApiKeyRequired }">
        <span class="gateway-status-icon"><AppIcon name="shield-check" :size="16" /></span>
        <div><span>客户端认证</span><strong>{{ config.clientApiKeyRequired ? "已强制" : "未强制" }}</strong></div>
      </article>
      <article>
        <span class="gateway-status-icon"><AppIcon name="gauge" :size="16" /></span>
        <div><span>最小输出预算</span><strong>{{ minimumOutputTokensDraft.toLocaleString() }} tokens</strong></div>
      </article>
      <article>
        <span class="gateway-status-icon"><AppIcon name="zap" :size="16" /></span>
        <div><span>全局信封</span><strong>{{ effectiveFormat().toUpperCase() }}</strong></div>
      </article>
      <article>
        <span class="gateway-status-icon"><AppIcon name="server" :size="16" /></span>
        <div><span>默认模型</span><strong class="gateway-model-name" :title="config.defaultModel">{{ config.defaultModel || "未设置" }}</strong></div>
      </article>
    </div>

    <section class="content-section gateway-section">
      <div class="section-heading gateway-section-heading">
        <span class="gateway-section-icon"><AppIcon name="key" :size="17" /></span>
        <div><h2>外部访问</h2><p>OpenAI 兼容客户端使用此凭据访问网关。</p></div>
        <span class="gateway-state" :class="config.clientApiKeyRequired ? 'good' : 'warn'">
          <AppIcon :name="config.clientApiKeyRequired ? 'check-circle' : 'alert-circle'" :size="13" />
          {{ config.clientApiKeyRequired ? "认证已启用" : "入口未强制认证" }}
        </span>
      </div>
      <div class="gateway-setting-row gateway-secret-row">
        <div class="gateway-setting-copy">
          <strong>客户端 API Key</strong>
          <small>敏感值默认遮罩，显示后会在 30 秒或窗口失焦时自动隐藏。</small>
        </div>
        <SecretValue :value="config.clientApiKey" label="客户端 API Key" :reset-token="secretResetToken" :copy="copySecret" />
      </div>
    </section>

    <section class="content-section gateway-section">
      <div class="section-heading gateway-section-heading">
        <span class="gateway-section-icon"><AppIcon name="gauge" :size="17" /></span>
        <div><h2>生成预算</h2><p>为推理过程保留足够的上游单轮输出空间。</p></div>
      </div>
      <div class="gateway-budget-layout">
        <label class="gateway-budget-control" for="minimum-output-budget">
          <span>最小上游输出预算</span>
          <div class="gateway-budget-input">
            <input
              id="minimum-output-budget"
              :value="minimumOutputTokensDraft"
              type="number"
              inputmode="numeric"
              min="0"
              max="8192"
              step="128"
              aria-describedby="minimum-output-budget-help"
              @input="updateBudget(($event.target as HTMLInputElement).value)"
            />
            <span>tokens</span>
          </div>
        </label>
        <div class="gateway-budget-range">
          <input
            :value="minimumOutputTokensDraft"
            type="range"
            min="0"
            max="8192"
            step="128"
            aria-label="最小上游输出预算滑杆"
            @input="updateBudget(($event.target as HTMLInputElement).value)"
          />
          <div aria-hidden="true"><span>0</span><span>4,096</span><span>8,192</span></div>
        </div>
        <div class="gateway-budget-presets" aria-label="预算预设值">
          <button v-for="value in [0, 2048, 4096, 8192]" :key="value" type="button" :aria-pressed="minimumOutputTokensDraft === value" @click="emit('update:minimumOutputTokensDraft', value)">{{ value === 0 ? "跟随客户端" : value.toLocaleString() }}</button>
        </div>
        <div class="gateway-budget-save">
          <p id="minimum-output-budget-help">0 表示完全尊重客户端预算；其他值作为每轮上游最小预算。</p>
          <button class="button button-primary" type="button" :disabled="savingBudget" :aria-busy="savingBudget" @click="emit('saveBudget')">
            <span v-if="savingBudget" class="spinner" aria-hidden="true"></span>
            <AppIcon v-else name="check" :size="14" />
            {{ savingBudget ? "保存中" : "保存生成预算" }}
          </button>
        </div>
      </div>
    </section>

    <section class="content-section gateway-section">
      <div class="section-heading gateway-section-heading">
        <span class="gateway-section-icon"><AppIcon name="zap" :size="17" /></span>
        <div><h2>工具调用协议</h2><p>解析端始终接受 JSON 与 XML；此处控制发送给模型的信封和进度播报。</p></div>
      </div>
      <div class="gateway-protocol-grid">
        <fieldset class="gateway-choice-group">
          <legend>全局信封格式</legend>
          <div class="gateway-choice-options gateway-format-options">
            <button v-for="option in formatOptions" :key="option.value" type="button" :data-state="effectiveFormat() === option.value ? 'active' : 'inactive'" :aria-pressed="effectiveFormat() === option.value" @click="emit('setToolFormat', option.value)">
              <strong>{{ option.label }}</strong><small>{{ option.description }}</small>
            </button>
          </div>
        </fieldset>
        <fieldset class="gateway-choice-group">
          <legend>进度播报</legend>
          <div class="gateway-choice-options gateway-preamble-options">
            <button v-for="option in preambleOptions" :key="option.value" type="button" :data-state="effectivePreamble() === option.value ? 'active' : 'inactive'" :aria-pressed="effectivePreamble() === option.value" @click="emit('setPreamble', option.value)">{{ option.label }}</button>
          </div>
          <p>只改变用户可见的过程信息，不影响模型能力或工具执行。</p>
        </fieldset>
      </div>
    </section>

    <AppDisclosure v-model:open="overridesOpen" title="按模型覆盖" :description="overrideSummary" open-label="查看模型">
      <div v-if="allModels.length" class="gateway-model-list">
        <div class="gateway-model-head" aria-hidden="true"><span>模型</span><span>信封格式</span><span>播报档位</span></div>
        <div v-for="model in allModels" :key="model" class="gateway-model-row" :class="{ overridden: modelHasOverride(model) }">
          <div class="gateway-model-identity">
            <code :title="model">{{ model }}</code>
            <span>{{ modelHasOverride(model) ? "自定义" : "跟随全局" }}</span>
          </div>
          <label><span>信封格式</span><select :aria-label="`${model} 的信封格式`" :value="settings.modelToolCallFormats?.[model] ?? ''" @change="emit('setModelToolFormat', model, ($event.target as HTMLSelectElement).value)"><option value="">跟随全局（{{ effectiveFormat() }}）</option><option value="auto">auto</option><option value="json">json</option><option value="xml">xml</option></select></label>
          <label><span>播报档位</span><select :aria-label="`${model} 的播报档位`" :value="settings.modelPreambleVerbosities?.[model] ?? ''" @change="emit('setModelPreamble', model, ($event.target as HTMLSelectElement).value)"><option value="">跟随全局（{{ effectivePreamble() }}）</option><option value="milestone">milestone</option><option value="normal">normal</option><option value="verbose">verbose</option><option value="quiet">quiet</option></select></label>
        </div>
      </div>
      <div v-else class="workspace-empty gateway-model-empty"><strong>暂无可配置模型</strong><p>请先在账号工作区获取或编辑模型列表。</p></div>
    </AppDisclosure>

    <section class="content-section gateway-section gateway-analytics-section">
      <div class="section-heading gateway-section-heading">
        <span class="gateway-section-icon"><AppIcon name="activity" :size="17" /></span>
        <div><h2>分析数据</h2><p>管理精确账本、价格目录、保留周期和审计清理。</p></div>
        <span class="gateway-state" :class="analytics?.health === 'healthy' ? 'good' : 'warn'">
          <AppIcon :name="analytics?.health === 'healthy' ? 'check-circle' : 'alert-circle'" :size="13" />
          {{ analytics?.health === "healthy" ? "账本正常" : "分析降级" }}
        </span>
      </div>

      <div class="gateway-analytics-summary">
        <div><span>精确账本起点</span><strong>{{ analyticsDate(analytics?.ledgerStartedAt) }}</strong></div>
        <div><span>价格目录</span><strong>{{ analytics?.priceStatus === "current" ? "最新" : analytics?.priceStatus === "stale" ? "已陈旧" : "不可用" }}</strong><small>{{ analyticsDate(analytics?.priceUpdatedAt) }}</small></div>
        <div><span>定价覆盖率</span><strong>{{ Math.round((analytics?.pricedCoverage ?? 0) * 100) }}%</strong><small>{{ analytics?.unpricedRequests ?? 0 }} 个未定价请求</small></div>
        <button class="button button-quiet" type="button" :disabled="refreshingPrices" :aria-busy="refreshingPrices" @click="emit('refreshPrices')"><span v-if="refreshingPrices" class="spinner" aria-hidden="true"></span><AppIcon v-else name="refresh-cw" :size="14" />{{ refreshingPrices ? "刷新中" : "刷新价格" }}</button>
      </div>

      <div class="gateway-analytics-retention">
        <div class="gateway-setting-copy"><strong>数据保留</strong><small>默认永久保留。按天设置只影响执行明细或分钟桶，日/月总账和价格版本永久保留。</small></div>
        <div class="analytics-retention-controls">
          <label><span>执行明细</span><select :value="retentionValue(retention.executionDays)" :disabled="savingRetention" @change="updateRetention('executionDays', ($event.target as HTMLSelectElement).value)"><option value="permanent">永久保留</option><option value="30">30 天</option><option value="90">90 天</option><option value="180">180 天</option><option value="365">365 天</option></select></label>
          <label><span>分钟趋势</span><select :value="retentionValue(retention.minuteDays)" :disabled="savingRetention" @change="updateRetention('minuteDays', ($event.target as HTMLSelectElement).value)"><option value="permanent">永久保留</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="365">365 天</option></select></label>
        </div>
      </div>

      <div class="gateway-analytics-cleanup">
        <div class="gateway-setting-copy"><strong>手动清理明细</strong><small>先生成精确预览，再二次确认。清理不会改变历史总消费、模型总账或价格版本。</small></div>
        <div class="analytics-cleanup-control"><label for="analytics-cleanup-cutoff">清理此时间之前<input id="analytics-cleanup-cutoff" type="datetime-local" :value="cleanupCutoff" @input="emit('update:cleanupCutoff', ($event.target as HTMLInputElement).value)" /></label><button class="button button-danger" type="button" :disabled="!cleanupCutoff || previewingCleanup" :aria-busy="previewingCleanup" @click="emit('previewCleanup')"><span v-if="previewingCleanup" class="spinner" aria-hidden="true"></span><AppIcon v-else name="trash-2" :size="14" />{{ previewingCleanup ? "计算中" : "预览清理" }}</button></div>
      </div>
      <p v-if="analytics?.error" class="inline-error">{{ analytics.error }}</p>
    </section>

    <section class="content-section gateway-session-section">
      <div>
        <span class="gateway-section-icon danger"><AppIcon name="log-out" :size="17" /></span>
        <div><h2>管理会话</h2><p>退出会清除当前浏览器中的管理员令牌和已显示的敏感值。</p></div>
      </div>
      <button class="button button-danger" type="button" @click="emit('signOut')"><AppIcon name="log-out" :size="14" />退出管理面板</button>
    </section>
  </section>
</template>
