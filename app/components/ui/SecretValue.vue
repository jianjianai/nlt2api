<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  value: string;
  label: string;
  resetToken?: number;
  copy?: (value: string, label: string) => void | Promise<void>;
}>(), { resetToken: 0 });

const revealed = ref(false);
let timer: number | undefined;
const masked = computed(() => props.value ? "••••••••••••" : "未配置");

function hide(): void {
  revealed.value = false;
  window.clearTimeout(timer);
  timer = undefined;
}

function toggle(): void {
  if (revealed.value) {
    hide();
    return;
  }
  revealed.value = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(hide, 30_000);
}

function onWindowBlur(): void { hide(); }

watch(() => props.resetToken, hide);
watch(() => props.value, hide);
window.addEventListener("blur", onWindowBlur);
onBeforeUnmount(() => {
  window.clearTimeout(timer);
  window.removeEventListener("blur", onWindowBlur);
});
</script>

<template>
  <div class="secret-value">
    <code :aria-label="`${label}：${revealed ? '已显示' : '已遮罩'}`">{{ revealed ? value || "未配置" : masked }}</code>
    <div class="secret-actions">
      <button class="inline-action" type="button" :disabled="!value" :aria-label="revealed ? `隐藏${label}` : `显示${label}，30秒后自动隐藏`" @click="toggle">{{ revealed ? "隐藏" : "显示" }}</button>
      <button class="inline-action" type="button" :disabled="!value" :aria-label="`复制${label}`" @click="copy?.(value, label)">复制</button>
    </div>
  </div>
</template>
