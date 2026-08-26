<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxRoot,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import AppIcon from "./AppIcon.vue";
import type { AppIconName } from "./AppIcon.vue";
import type { ThemeId, WorkspaceId } from "../../types/admin.ts";

interface PaletteAction {
  id: string;
  group: "工作区" | "操作" | "主题";
  label: string;
  description: string;
  icon: AppIconName;
  active?: boolean;
}

const props = defineProps<{
  open: boolean;
  workspace: WorkspaceId;
  autoRefresh: boolean;
  theme: ThemeId;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  select: [workspace: WorkspaceId];
  refresh: [];
  toggleAutoRefresh: [];
  changeTheme: [theme: ThemeId];
}>();

const query = ref("");
const workspaceActions: Array<Omit<PaletteAction, "active">> = [
  { id: "workspace:overview", group: "工作区", label: "运行概览", description: "代理三态、凭证水位与铸票速率", icon: "layout-dashboard" },
  { id: "workspace:proxies", group: "工作区", label: "代理池", description: "导入、测活与三态管理", icon: "globe" },
  { id: "workspace:tickets", group: "工作区", label: "凭证对池", description: "查看 (代理, 凭证) 对与剩余寿命", icon: "key" },
  { id: "workspace:minters", group: "工作区", label: "授权服务", description: "在线授权服务与铸票统计", icon: "server" },
  { id: "workspace:settings", group: "工作区", label: "运行参数", description: "凭证寿命、水位与测活策略", icon: "settings" },
];
const actions = computed<PaletteAction[]>(() => [
  ...workspaceActions.map((action) => ({ ...action, active: action.id === `workspace:${props.workspace}` })),
  { id: "action:refresh", group: "操作", label: "刷新当前数据", description: "立即同步控制台状态", icon: "refresh-cw" },
  { id: "action:auto-refresh", group: "操作", label: props.autoRefresh ? "关闭自动刷新" : "开启自动刷新", description: "每 5 秒同步一次运行状态", icon: "activity", active: props.autoRefresh },
  { id: "theme:light", group: "主题", label: "浅色主题", description: "高对比明亮工作区", icon: "sun", active: props.theme === "light" },
  { id: "theme:dark", group: "主题", label: "暗色主题", description: "适合低光环境", icon: "moon", active: props.theme === "dark" },
]);

const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  if (!needle) return actions.value;
  return actions.value.filter((action) => `${action.label} ${action.description} ${action.id}`.toLocaleLowerCase().includes(needle));
});
const groups = ["工作区", "操作", "主题"] as const;
const actionsFor = (group: PaletteAction["group"]) => filtered.value.filter((action) => action.group === group);

function run(value: unknown): void {
  const id = String(value ?? "");
  if (!id) return;
  if (id.startsWith("workspace:")) emit("select", id.slice(10) as WorkspaceId);
  else if (id === "action:refresh") emit("refresh");
  else if (id === "action:auto-refresh") emit("toggleAutoRefresh");
  else if (id.startsWith("theme:")) emit("changeTheme", id.slice(6) as ThemeId);
  emit("update:open", false);
}

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  emit("update:open", false);
}

watch(() => props.open, (open) => { if (open) query.value = ""; });
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal disabled>
      <DialogOverlay class="command-overlay">
        <DialogContent class="command-dialog" @keydown.capture="closeOnEscape">
          <DialogTitle class="sr-only">快速操作</DialogTitle>
          <DialogDescription class="sr-only">搜索工作区、操作或主题并按回车执行</DialogDescription>
          <ComboboxRoot :model-value="undefined" :open="true" :ignore-filter="true" @update:model-value="run">
            <div class="command-search"><AppIcon name="search" :size="18" /><ComboboxInput v-model="query" aria-label="搜索快速操作" autocomplete="off" placeholder="搜索工作区、操作或主题…" /></div>
            <ComboboxContent class="command-results">
              <template v-for="group in groups" :key="group">
                <ComboboxGroup v-if="actionsFor(group).length" class="command-group">
                  <ComboboxLabel class="command-group-title">{{ group }}</ComboboxLabel>
                  <ComboboxItem v-for="action in actionsFor(group)" :key="action.id" :value="action.id" class="command-item">
                    <span class="command-icon"><AppIcon :name="action.icon" :size="17" /></span>
                    <span class="command-copy"><strong>{{ action.label }}</strong><small>{{ action.description }}</small></span>
                    <AppIcon v-if="action.active" class="command-check" name="check" :size="15" />
                  </ComboboxItem>
                </ComboboxGroup>
              </template>
              <div v-if="!filtered.length" class="command-empty"><AppIcon name="search" :size="18" /><strong>没有匹配操作</strong><span>尝试搜索账号、刷新或主题。</span></div>
            </ComboboxContent>
          </ComboboxRoot>
        </DialogContent>
      </DialogOverlay>
    </DialogPortal>
  </DialogRoot>
</template>
