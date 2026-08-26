<script setup lang="ts">
import AppIcon from "./ui/AppIcon.vue";
import type { TicketPublic } from "../types/admin.ts";
import { formatRelative, formatRemaining } from "../utils/admin-ui.ts";

defineProps<{
  tickets: TicketPublic[];
  available: number;
  total: number;
  minAvailable: number;
  ticketTtlSeconds: number;
  clearing: boolean;
  now: number;
}>();

const emit = defineEmits<{ clear: [] }>();
</script>

<template>
  <section class="workspace-page">
    <header class="page-heading page-heading-actions">
      <div>
        <p class="section-kicker">凭证资源</p>
        <h1>凭证对池</h1>
        <p>
          每行是一组 (代理, 凭证)。上游凭证寿命约 {{ ticketTtlSeconds }} 秒，取用时优先消耗最接近过期的一组，过期的会被自动清理。
        </p>
      </div>
      <div class="page-actions">
        <button class="button button-quiet" type="button" :disabled="clearing || total === 0" :aria-busy="clearing" @click="emit('clear')">
          <span v-if="clearing" class="spinner" aria-hidden="true"></span>
          <AppIcon v-else name="trash-2" :size="14" />{{ clearing ? "清空中" : "清空凭证池" }}
        </button>
      </div>
    </header>

    <div class="resource-summary">
      <button type="button" disabled><strong>{{ available }}</strong><span>可用</span></button>
      <button type="button" disabled><strong>{{ total }}</strong><span>池内总数</span></button>
      <button type="button" disabled><strong>{{ minAvailable }}</strong><span>水位下限</span></button>
    </div>

    <section class="content-section">
      <div class="section-heading">
        <div><h2>未消耗的凭证对</h2><p>凭证与代理 URL 均已掩码。</p></div>
        <span class="section-count">{{ tickets.length }}</span>
      </div>

      <div v-if="tickets.length === 0" class="workspace-empty">
        <strong>凭证池为空</strong>
        <p>确认有在线授权服务且存在可铸票的活跃代理；补充任务会在下一个检查周期自动下发。</p>
      </div>

      <div v-else class="proxy-resource-list">
        <article v-for="ticket in tickets" :key="ticket.id">
          <div class="proxy-address">
            <span class="badge" :class="ticket.remainingMs > 30_000 ? 'good' : 'warn'">{{ formatRemaining(ticket.remainingMs) }}</span>
            <code>{{ ticket.maskedProxyUrl }}</code>
            <code class="muted">{{ ticket.maskedToken }}</code>
          </div>
          <dl>
            <div><dt>来源标记</dt><dd class="mono">{{ ticket.source }}</dd></div>
            <div><dt>铸造时间</dt><dd>{{ formatRelative(ticket.mintedAt, now) }}</dd></div>
            <div><dt>铸造者</dt><dd class="mono">{{ ticket.minterId ?? "—" }}</dd></div>
          </dl>
        </article>
      </div>
    </section>
  </section>
</template>
