<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import AppSwitch from "./ui/AppSwitch.vue";
import AppTooltip from "./ui/AppTooltip.vue";
import type { AppIconName } from "./ui/AppIcon.vue";
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

const commandOpen = ref(false);
const commandTrigger = ref<HTMLButtonElement | null>(null);
let commandOpener: HTMLElement | null = null;
const CommandPalette = defineAsyncComponent(() => import("./ui/CommandPalette.vue"));

function setCommandOpen(open: boolean): void {
  if (open) {
    if (!commandOpen.value) {
      commandOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    commandOpen.value = true;
    return;
  }
  commandOpen.value = false;
  const target = commandOpener;
  commandOpener = null;
  window.requestAnimationFrame(() => (target?.isConnected ? target : commandTrigger.value)?.focus());
}

const themeOptions: Array<{ id: ThemeId; label: string; icon: AppIconName }> = [
  { id: "light", label: "浅色", icon: "sun" },
  { id: "dark", label: "暗色", icon: "moon" },
];
const currentThemeOption = computed(() => themeOptions.find((option) => option.id === props.theme) ?? themeOptions[0]!);

function cycleTheme(): void {
  const currentIndex = themeOptions.findIndex((option) => option.id === props.theme);
  emit("changeTheme", themeOptions[(currentIndex + 1) % themeOptions.length]!.id);
}

const operationalItems: Array<{ id: Exclude<WorkspaceId, "settings">; label: string; short: string; icon: AppIconName }> = [
  { id: "overview", label: "运行概览", short: "概览", icon: "layout-dashboard" },
  { id: "accounts", label: "账号", short: "账号", icon: "users" },
  { id: "proxies", label: "代理池", short: "代理", icon: "globe" },
  { id: "scheduler", label: "调度策略", short: "调度", icon: "gauge" },
  { id: "records", label: "请求记录", short: "记录", icon: "file-text" },
];
const workspaceShortcuts: WorkspaceId[] = [...operationalItems.map((item) => item.id), "settings"];

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function onGlobalShortcut(event: KeyboardEvent): void {
  const key = event.key.toLowerCase();
  const editable = isEditableTarget(event.target);
  const activeModal = document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
  if ((event.ctrlKey || event.metaKey) && key === "k") {
    if (activeModal && !commandOpen.value) return;
    event.preventDefault();
    setCommandOpen(!commandOpen.value);
    return;
  }
  if (commandOpen.value || editable || activeModal) return;
  if (event.altKey && /^[1-6]$/.test(event.key)) {
    event.preventDefault();
    emit("select", workspaceShortcuts[Number(event.key) - 1]!);
  } else if (event.altKey && key === "r" && !props.loading) {
    event.preventDefault();
    emit("refresh");
  }
}

onMounted(() => window.addEventListener("keydown", onGlobalShortcut));
onUnmounted(() => window.removeEventListener("keydown", onGlobalShortcut));
</script>

<template>
  <div class="workspace-shell">
    <header class="workspace-topbar">
      <div class="workspace-brand">
        <span class="workspace-brand-mark"><AppIcon name="activity" :size="16" /></span>
        <span class="workspace-brand-name">DeepInfra 网关</span>
      </div>
      <div class="workspace-top-actions">
        <AppTooltip text="打开快速操作"><button ref="commandTrigger" class="command-trigger" type="button" aria-label="打开快速操作" @click="setCommandOpen(true)"><AppIcon name="search" :size="15" /><span>快速操作</span></button></AppTooltip>
        <span class="workspace-connection" :class="{ busy: loading, offline: !connected }" role="status" aria-live="polite">
          <i aria-hidden="true"></i>{{ loading ? "正在同步" : connected ? "服务正常" : "未连接" }}
        </span>
        <label class="workspace-auto-refresh"><AppSwitch :model-value="autoRefresh" label="每5秒自动刷新" @update:model-value="emit('toggleAutoRefresh')" /><span>自动刷新</span></label>
        <div class="theme-picker" role="group" aria-label="主题"><AppTooltip v-for="option in themeOptions" :key="option.id" :text="`${option.label}主题`"><button type="button" :class="{ active: theme === option.id }" :aria-pressed="theme === option.id" :aria-label="`切换到${option.label}主题`" @click="emit('changeTheme', option.id)"><AppIcon :name="option.icon" :size="14" /></button></AppTooltip></div>
        <AppTooltip :text="`当前${currentThemeOption.label}主题，点击切换`"><button class="icon-action mobile-theme" type="button" :aria-label="`切换主题，当前${currentThemeOption.label}主题`" @click="cycleTheme"><AppIcon :name="currentThemeOption.icon" :size="16" /></button></AppTooltip>
        <AppTooltip text="网关设置"><button class="icon-action mobile-settings" type="button" :aria-current="workspace === 'settings' ? 'page' : undefined" aria-label="网关设置" @click="emit('select', 'settings')"><AppIcon name="settings" :size="16" /></button></AppTooltip>
        <button class="button button-quiet topbar-refresh" type="button" :disabled="loading" :aria-busy="loading" aria-label="刷新当前数据" @click="emit('refresh')"><span v-if="loading" class="spinner" aria-hidden="true"></span><AppIcon v-else name="refresh-cw" :size="14" /><span class="topbar-refresh-label">{{ loading ? "同步中" : "刷新" }}</span></button>
        <button class="button button-quiet signout-action" type="button" @click="emit('signOut')"><AppIcon name="log-out" :size="14" />退出</button>
      </div>
    </header>

    <div class="workspace-layout">
      <aside class="workspace-rail" aria-label="管理工作区">
        <div class="workspace-rail-heading">工作台</div>
        <nav class="workspace-nav">
          <button v-for="item in operationalItems" :key="item.id" type="button" :class="{ active: workspace === item.id }" :aria-current="workspace === item.id ? 'page' : undefined" @click="emit('select', item.id)">
            <AppIcon :name="item.icon" :size="16" /><span>{{ item.label }}</span>
          </button>
        </nav>
        <button class="workspace-settings-link" type="button" :class="{ active: workspace === 'settings' }" :aria-current="workspace === 'settings' ? 'page' : undefined" @click="emit('select', 'settings')"><AppIcon name="settings" :size="16" />网关设置</button>
      </aside>
      <main class="workspace-main"><slot /></main>
    </div>

    <nav class="workspace-mobile-nav" aria-label="移动端工作区">
      <button v-for="item in operationalItems" :key="item.id" type="button" :class="{ active: workspace === item.id }" :aria-current="workspace === item.id ? 'page' : undefined" @click="emit('select', item.id)"><AppIcon :name="item.icon" :size="18" /><span>{{ item.short }}</span></button>
    </nav>
    <CommandPalette v-if="commandOpen" :open="commandOpen" :workspace="workspace" :auto-refresh="autoRefresh" :theme="theme" @update:open="setCommandOpen" @select="emit('select', $event)" @refresh="emit('refresh')" @toggle-auto-refresh="emit('toggleAutoRefresh')" @change-theme="emit('changeTheme', $event)" />
  </div>
</template>
