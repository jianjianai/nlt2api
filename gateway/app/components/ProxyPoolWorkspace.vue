<script setup lang="ts">
import { computed, ref } from "vue";
import AppDisclosure from "./ui/AppDisclosure.vue";
import AppIcon from "./ui/AppIcon.vue";
import type { ImportSummary, ProxyFilter, ProxyKind, ProxyPublic, ProxyStatus } from "../types/admin.ts";
import { formatLatency, formatRelative, PROXY_STATUS_LABEL, PROXY_STATUS_TONE } from "../utils/admin-ui.ts";

const props = defineProps<{
  proxies: ProxyPublic[];
  counts: Record<ProxyStatus, number>;
  total: number;
  filter: ProxyFilter;
  importText: string;
  importProtocol: ProxyKind;
  importSummary: ImportSummary | null;
  busyIds: Set<string>;
  importing: boolean;
  checking: boolean;
  now: number;
}>();

const emit = defineEmits<{
  "update:filter": [value: ProxyFilter];
  "update:importText": [value: string];
  "update:importProtocol": [value: ProxyKind];
  import: [];
  checkScope: [scope: "pending" | "unavailable" | "all"];
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
]);
const protocols: ProxyKind[] = ["http", "socks5", "socks4"];
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
        <div><h2>代理列表</h2><p>URL 已掩码，凭证不会离开服务端。</p></div>
        <span class="section-count">{{ proxies.length }}</span>
      </div>

      <div v-if="proxies.length === 0" class="workspace-empty">
        <strong>没有匹配的代理</strong>
        <p>导入代理后，后台测活器会在下一个周期内探测它们。</p>
      </div>

      <div v-else class="proxy-resource-list">
        <article v-for="proxy in proxies" :key="proxy.id">
          <div class="proxy-address">
            <span class="badge" :class="PROXY_STATUS_TONE[proxy.status]">{{ PROXY_STATUS_LABEL[proxy.status] }}</span>
            <code>{{ proxy.maskedUrl }}</code>
            <span v-if="proxy.leased" class="badge muted">已被领取</span>
            <span v-if="proxy.rateLimitedUntil" class="badge" :class="proxy.cooldownReason === 'ip_blocked' ? 'bad' : 'warn'">
              {{ proxy.cooldownReason === "ip_blocked" ? "403 封禁中" : "429 冷却中" }}
            </span>
            <span v-if="!proxy.mintable" class="badge warn">不可铸票</span>
          </div>
          <dl>
            <div><dt>协议</dt><dd class="mono">{{ proxy.kind }}</dd></div>
            <div><dt>延迟</dt><dd>{{ formatLatency(proxy.latencyMs) }}</dd></div>
            <div><dt>可用凭证</dt><dd>{{ proxy.availableTickets }}</dd></div>
            <div><dt>失败次数</dt><dd>{{ proxy.failureCount }}</dd></div>
            <div><dt>最近测活</dt><dd>{{ formatRelative(proxy.checkedAt, now) }}</dd></div>
            <div><dt>最近使用</dt><dd>{{ formatRelative(proxy.lastUsedAt, now) }}</dd></div>
            <div><dt>最近铸票</dt><dd>{{ formatRelative(proxy.lastMintedAt, now) }}</dd></div>
            <div><dt>最近健康</dt><dd>{{ formatRelative(proxy.healthyAt, now) }}</dd></div>
            <div v-if="proxy.rateLimitedUntil"><dt>冷却解除</dt><dd>{{ formatRelative(proxy.rateLimitedUntil, now) }}</dd></div>
            <div v-if="proxy.retryAfter"><dt>冷却至</dt><dd>{{ formatRelative(proxy.retryAfter, now) }}</dd></div>
            <div v-if="proxy.lastError"><dt>最近错误</dt><dd>{{ proxy.lastError }}</dd></div>
          </dl>
          <footer>
            <button class="button button-quiet" type="button" :disabled="busyIds.has(proxy.id)" :aria-busy="busyIds.has(proxy.id)" @click="emit('check', proxy)">
              <span v-if="busyIds.has(proxy.id)" class="spinner" aria-hidden="true"></span>
              <AppIcon v-else name="refresh-cw" :size="14" />测活
            </button>
            <button
              v-if="proxy.status === 'unavailable'"
              class="button button-quiet"
              type="button"
              :disabled="busyIds.has(proxy.id)"
              @click="emit('reactivate', proxy)"
            >
              <AppIcon name="check-circle" :size="14" />重新启用
            </button>
            <button class="text-button danger" type="button" :disabled="busyIds.has(proxy.id)" @click="emit('delete', proxy)">
              <AppIcon name="trash-2" :size="14" />删除
            </button>
          </footer>
        </article>
      </div>
    </section>
  </section>
</template>
