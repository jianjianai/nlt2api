<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import type { MinterSessionPublic } from "../types/admin.ts";
import { formatRelative, formatTime } from "../utils/admin-ui.ts";

const props = defineProps<{
  sessions: MinterSessionPublic[];
  online: number;
  inflight: number;
  busyIds: Set<string>;
  now: number;
}>();

const emit = defineEmits<{ disconnect: [session: MinterSessionPublic] }>();

const onlineSessions = computed(() => props.sessions.filter((session) => session.online));
const offlineSessions = computed(() => props.sessions.filter((session) => !session.online));
</script>

<template>
  <section class="workspace-page">
    <header class="page-heading">
      <div>
        <p class="section-kicker">铸票能力</p>
        <h1>授权服务</h1>
        <p>授权服务主动连入本服务，领取空闲代理并回传凭证。它自身无管理后台，只需配置转发服务地址与令牌。</p>
      </div>
    </header>

    <div class="resource-summary">
      <button type="button" disabled><strong>{{ online }}</strong><span>在线</span></button>
      <button type="button" disabled><strong>{{ inflight }}</strong><span>进行中铸票</span></button>
      <button type="button" disabled><strong>{{ offlineSessions.length }}</strong><span>历史会话</span></button>
    </div>

    <section class="content-section">
      <div class="section-heading">
        <div><h2>在线列表</h2><p>心跳超过 90 秒未更新的连接会被服务端主动关闭。</p></div>
        <span class="section-count">{{ onlineSessions.length }}</span>
      </div>

      <div v-if="onlineSessions.length === 0" class="workspace-empty">
        <strong>没有在线授权服务</strong>
        <p>在授权服务上设置 GATEWAY_URL 与 MINTER_TOKEN 后启动，它会自动连接并等待任务。</p>
      </div>

      <div v-else class="proxy-resource-list">
        <article v-for="session in onlineSessions" :key="session.id">
          <div class="proxy-address">
            <span class="badge good">在线</span>
            <code>{{ session.label ?? session.agentId }}</code>
            <span class="muted mono">{{ session.agentId }}</span>
          </div>
          <dl>
            <div><dt>平台</dt><dd class="mono">{{ session.platform }}</dd></div>
            <div><dt>版本</dt><dd class="mono">{{ session.version }}</dd></div>
            <div><dt>并发</dt><dd>{{ session.concurrency }}</dd></div>
            <div><dt>进行中</dt><dd>{{ session.inflight }}</dd></div>
            <div><dt>持有租约</dt><dd>{{ session.leases }}</dd></div>
            <div><dt>已铸 / 失败</dt><dd>{{ session.mintedCount }} / {{ session.failedCount }}</dd></div>
            <div><dt>连接于</dt><dd>{{ formatRelative(session.connectedAt, now) }}</dd></div>
            <div><dt>最近心跳</dt><dd>{{ formatRelative(session.lastSeenAt, now) }}</dd></div>
            <div v-if="session.remoteAddr"><dt>来源地址</dt><dd class="mono">{{ session.remoteAddr }}</dd></div>
            <div v-if="session.lastError"><dt>最近错误</dt><dd>{{ session.lastError }}</dd></div>
          </dl>
          <footer>
            <button class="text-button danger" type="button" :disabled="busyIds.has(session.id)" @click="emit('disconnect', session)">
              <AppIcon name="log-out" :size="14" />断开
            </button>
          </footer>
        </article>
      </div>
    </section>

    <section v-if="offlineSessions.length" class="content-section">
      <div class="section-heading">
        <div><h2>历史会话</h2><p>断线时其持有的代理租约会立即归还。</p></div>
        <span class="section-count">{{ offlineSessions.length }}</span>
      </div>
      <div class="overview-table">
        <div v-for="session in offlineSessions" :key="session.id" class="overview-row">
          <div><strong>{{ session.label ?? session.agentId }}</strong><span class="mono">{{ session.platform }} · {{ session.version }}</span></div>
          <span class="muted">已铸 {{ session.mintedCount }} · 失败 {{ session.failedCount }}</span>
          <span class="muted">{{ formatTime(session.disconnectedAt) }}</span>
        </div>
      </div>
    </section>
  </section>
</template>
