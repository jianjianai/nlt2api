<script setup lang="ts">
import { watch } from "vue";
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  returnFocus?: string;
}>(), { busyLabel: "处理中…", busy: false });

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [];
}>();
let opener: HTMLElement | null = null;

watch(() => props.open, (open, wasOpen) => {
  if (open && !wasOpen) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
});

function updateOpen(value: boolean): void {
  if (!value && props.busy) return;
  emit("update:open", value);
}

function restoreOpener(event: Event): void {
  event.preventDefault();
  const target = opener;
  opener = null;
  window.requestAnimationFrame(() => {
    const configuredFallback = props.returnFocus ? document.querySelector<HTMLElement>(props.returnFocus) : null;
    const genericFallback = document.querySelector<HTMLElement>(".workspace-main button:not([disabled]), .workspace-topbar button:not([disabled])");
    (target?.isConnected && target !== document.body ? target : configuredFallback ?? genericFallback)?.focus();
  });
}
</script>

<template>
  <AlertDialogRoot :open="open" @update:open="updateOpen">
    <AlertDialogPortal disabled>
      <AlertDialogOverlay class="modal-backdrop">
        <AlertDialogContent class="modal modal-confirm" @close-auto-focus="restoreOpener">
          <header class="modal-head"><AlertDialogTitle as-child><h2>{{ title }}</h2></AlertDialogTitle></header>
          <AlertDialogDescription as-child><p class="confirm-text">{{ description }}</p></AlertDialogDescription>
          <footer class="modal-foot">
            <AlertDialogCancel as-child><button class="button button-quiet" type="button" :disabled="busy">取消</button></AlertDialogCancel>
            <button class="button button-danger-solid" type="button" :disabled="busy" :aria-busy="busy" @click="emit('confirm')"><span v-if="busy" class="spinner" aria-hidden="true"></span>{{ busy ? busyLabel : confirmLabel }}</button>
          </footer>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
