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
  { id: "workspace:overview", group: "工作区", label: "运行概览", description: "查看健康、负载与待处理问题", icon: "layout-dashboard" },
  { id: "workspace:accounts", group: "工作区", label: "账号", description: "管理账号、会话、模型与出口", icon: "users" },
  { id: "workspace:proxies", group: "工作区", label: "代理池", description: "管理代理、测活与轮换策略", icon: "globe" },
  { id: "workspace:scheduler", group: "工作区", label: "调度策略", description: "配置容量、限流与等待队列", icon: "gauge" },
  { id: "workspace:records", group: "工作区", label: "请求记录", description: "诊断客户端与上游调用链", icon: "file-text" },
  { id: "workspace:settings", group: "工作区", label: "网关设置", description: "配置访问、预算与工具协议", icon: "settings" },
];
const actions = computed<PaletteAction[]>(() => [
  ...workspaceActions.map((action) => ({ ...action, active: action.id === `workspace:${props.workspace}` })),
  { id: "action:refresh", group: "操作", label: "刷新当前数据", description: "立即同步控制台状态", icon: "refresh-cw" },
  { id: "action:auto-refresh", group: "操作", label: props.autoRefresh ? "关闭自动刷新" : "开启自动刷新", description: "每 30 秒同步一次运行状态", icon: "activity", active: props.autoRefresh },
  { id: "theme:light", group: "主题", label: "浅色主题", description: "高对比明亮工作区", icon: "sun", active: props.theme === "light" },
  { id: "theme:gray", group: "主题", label: "高级灰主题", description: "低饱和专注工作区", icon: "contrast", active: props.theme === "gray" },
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
