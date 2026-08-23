<script setup lang="ts">
import type { ThemeId, WorkspaceId } from "../types/admin.ts";

const props = withDefaults(defineProps<{
  workspace: WorkspaceId;
  loading: boolean;
  connected: boolean;
  autoRefresh?: boolean;
  theme: ThemeId;
}>(), { autoRefresh: false });

const emit = defineEmits<{
  select: [workspace: WorkspaceId];
  refresh: [];
  signOut: [];
  toggleAutoRefresh: [];
  changeTheme: [theme: ThemeId];
}>();

const themeOptions: Array<{ id: ThemeId; label: string; short: string }> = [
  { id: "light", label: "浅色", short: "浅" },
  { id: "gray", label: "高级灰", short: "灰" },
  { id: "dark", label: "暗色", short: "暗" },
];

const operationalItems: Array<{ id: Exclude<WorkspaceId, "settings">; label: string; short: string; icon: string }> = [
  { id: "overview", label: "运行概览", short: "概览", icon: "⌂" },
  { id: "accounts", label: "账号", short: "账号", icon: "人" },
  { id: "proxies", label: "代理池", short: "代理", icon: "↗" },
  { id: "scheduler", label: "调度策略", short: "调度", icon: "≋" },
  { id: "records", label: "请求记录", short: "记录", icon: "◎" },
];
</script>

<template>
  <div class="workspace-shell">
    <header class="workspace-topbar">
      <div class="workspace-brand">
        <span class="workspace-brand-mark">NW</span>
        <span class="workspace-brand-name">NeuralWatt 网关</span>
      </div>
      <div class="workspace-top-actions">
        <span class="workspace-connection" :class="{ busy: loading, offline: !connected }">
          <i aria-hidden="true"></i>{{ loading ? "刷新中" : connected ? "服务正常" : "未连接" }}
        </span>
        <label class="workspace-auto-refresh"><button class="switch" :class="{ on: autoRefresh }" type="button" :aria-pressed="autoRefresh" aria-label="每30秒自动刷新" @click="emit('toggleAutoRefresh')"><span></span></button><span>自动刷新</span></label>
        <div class="theme-picker" role="group" aria-label="主题"><button v-for="option in themeOptions" :key="option.id" type="button" :class="{ active: theme === option.id }" :aria-pressed="theme === option.id" :aria-label="`切换到${option.label}主题`" @click="emit('changeTheme', option.id)">{{ option.short }}</button></div>
        <button class="icon-action mobile-settings" type="button" :aria-current="workspace === 'settings' ? 'page' : undefined" aria-label="网关设置" title="网关设置" @click="emit('select', 'settings')">⚙</button>
        <button class="button button-quiet" type="button" :disabled="loading" @click="emit('refresh')">{{ loading ? "刷新中…" : "刷新" }}</button>
        <button class="button button-quiet signout-action" type="button" @click="emit('signOut')">退出登录</button>
      </div>
    </header>

    <div class="workspace-layout">
      <aside class="workspace-rail" aria-label="管理工作区">
        <div class="workspace-rail-heading">工作台</div>
        <nav class="workspace-nav">
          <button v-for="item in operationalItems" :key="item.id" type="button" :class="{ active: workspace === item.id }" :aria-current="workspace === item.id ? 'page' : undefined" @click="emit('select', item.id)">
            <span aria-hidden="true" class="workspace-nav-icon">{{ item.icon }}</span><span>{{ item.label }}</span>
          </button>
        </nav>
        <button class="workspace-settings-link" type="button" :class="{ active: workspace === 'settings' }" :aria-current="workspace === 'settings' ? 'page' : undefined" @click="emit('select', 'settings')"><span aria-hidden="true">⚙</span>网关设置</button>
      </aside>
      <main class="workspace-main"><slot /></main>
    </div>

    <nav class="workspace-mobile-nav" aria-label="移动端工作区">
      <button v-for="item in operationalItems" :key="item.id" type="button" :class="{ active: workspace === item.id }" :aria-current="workspace === item.id ? 'page' : undefined" @click="emit('select', item.id)"><b aria-hidden="true">{{ item.icon }}</b><span>{{ item.short }}</span></button>
    </nav>
  </div>
</template>
