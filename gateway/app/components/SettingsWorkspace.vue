<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import type { GatewaySettings, OverviewSnapshot, SettingBounds, SettingKey } from "../types/admin.ts";
import { SETTING_LABEL } from "../utils/admin-ui.ts";

const props = defineProps<{
  draft: GatewaySettings;
  bounds: SettingBounds | null;
  overview: OverviewSnapshot | null;
  saving: boolean;
  dirty: boolean;
}>();

const emit = defineEmits<{
  update: [key: SettingKey, value: number];
  save: [];
  reset: [];
}>();

const groups: Array<{ title: string; description: string; keys: SettingKey[] }> = [
  {
    title: "凭证对池",
    description: "凭证寿命受上游约束：实测铸后约 3 分钟仍可用，约 4 分钟必失效。",
    keys: ["ticketTtlSeconds", "ticketMinRemainingSeconds", "ticketCleanupIntervalSeconds"],
  },
  {
    title: "自适应水位",
    description: "按实测消耗速率 × 备货时长动态决定常备量，并在 下限~上限 之间取值。长时间无请求则暂停铸票。",
    keys: ["minAvailableTickets", "maxAvailableTickets", "targetLeadSeconds", "demandWindowSeconds", "idleAfterSeconds"],
  },
  {
    title: "请求排队",
    description: "凭证不足时请求排队等待而不直接失败；客户端断开即刻退出队列。",
    keys: ["queueMaxSize", "queueTimeoutSeconds"],
  },
  {
    title: "出口轮转",
    description: "限流绑定在出口 IP 上：新对话取最久未用的出口，同一对话在黏滞窗口内固定出口，遭 429 的出口暂停使用。",
    keys: ["affinityTtlSeconds", "rateLimitCooldownSeconds"],
  },
  {
    title: "补充编排",
    description: "水位不足时向在线授权服务下发铸票任务。",
    keys: ["refillIntervalSeconds", "mintRequestTimeoutSeconds", "proxyLeaseSeconds"],
  },
  {
    title: "代理测活",
    description: "经代理拉取上游模型目录判定健康度。",
    keys: ["proxyCheckIntervalSeconds", "proxyCheckTimeoutSeconds", "proxyCheckConcurrency", "proxyFailureThreshold", "proxyRetryCooldownSeconds"],
  },
  {
    title: "转发",
    description: "每次重试都会消耗一组新的代理与凭证。",
    keys: ["maxAttempts", "upstreamTimeoutMs", "modelsCacheSeconds"],
  },
];

const credentials = computed(() => {
  const config = props.overview?.config;
  if (!config) return [];
  return [
    { key: "GATEWAY_API_KEY", label: "客户端密钥", configured: config.apiKeyConfigured, note: config.allowAnonymous ? "已允许匿名访问" : "用于 /v1 接口鉴权" },
    { key: "GATEWAY_ADMIN_TOKEN", label: "管理令牌", configured: config.adminTokenConfigured, note: "用于本控制台与 /api/admin" },
    { key: "MINTER_TOKEN", label: "授权服务令牌", configured: config.minterTokenConfigured, note: "用于 /ws/minter 接入" },
  ];
});

function onInput(key: SettingKey, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) emit("update", key, Math.floor(value));
}
</script>

<template>
  <section class="workspace-page">
    <header class="page-heading page-heading-actions">
      <div>
        <p class="section-kicker">配置</p>
        <h1>运行参数</h1>
        <p>参数保存在服务端数据库，修改后立即生效，无需重启。密钥只能通过环境变量配置。</p>
      </div>
      <div class="page-actions">
        <button class="button button-quiet" type="button" :disabled="!dirty || saving" @click="emit('reset')">
          <AppIcon name="arrow-left" :size="14" />放弃修改
        </button>
        <button class="button button-primary" type="button" :disabled="!dirty || saving" :aria-busy="saving" @click="emit('save')">
          <span v-if="saving" class="spinner" aria-hidden="true"></span>
          <AppIcon v-else name="check" :size="14" />{{ saving ? "保存中" : "保存" }}
        </button>
      </div>
    </header>

    <section v-for="group in groups" :key="group.title" class="content-section">
      <div class="section-heading"><div><h2>{{ group.title }}</h2><p>{{ group.description }}</p></div></div>
      <div class="field-grid">
        <label v-for="key in group.keys" :key="key">
          <span>{{ SETTING_LABEL[key].label }}</span>
          <input
            :value="draft[key]"
            type="number"
            :min="bounds?.[key].min"
            :max="bounds?.[key].max"
            step="1"
            @input="onInput(key, $event)"
          />
          <small>{{ SETTING_LABEL[key].hint }}<template v-if="bounds"> 允许 {{ bounds[key].min }} ~ {{ bounds[key].max }}。</template></small>
        </label>
      </div>
    </section>

    <section class="content-section">
      <div class="section-heading">
        <div><h2>密钥状态</h2><p>只显示是否已配置，明文永不回显。</p></div>
      </div>
      <div class="overview-table">
        <div v-for="item in credentials" :key="item.key" class="overview-row">
          <div><strong>{{ item.label }}</strong><span class="mono">{{ item.key }}</span></div>
          <span class="badge" :class="item.configured ? 'good' : 'bad'">{{ item.configured ? "已配置" : "未配置" }}</span>
          <span class="muted">{{ item.note }}</span>
        </div>
      </div>
    </section>
  </section>
</template>
