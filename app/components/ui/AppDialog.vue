<script setup lang="ts">
import { watch } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import AppIcon from "./AppIcon.vue";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description: string;
  busy?: boolean;
  wide?: boolean;
}>(), { busy: false, wide: false });

const emit = defineEmits<{ "update:open": [value: boolean] }>();
let opener: HTMLElement | null = null;

watch(() => props.open, (open, wasOpen) => {
  if (open && !wasOpen) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
});

function updateOpen(value: boolean): void {
  if (!value && props.busy) return;
  emit("update:open", value);
}

function blockClose(event: Event): void {
  if (props.busy) event.preventDefault();
}

function focusFirstField(event: Event): void {
  event.preventDefault();
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(".modal[data-state='open'] input:not([disabled]), .modal[data-state='open'] textarea:not([disabled]), .modal[data-state='open'] select:not([disabled])")?.focus();
  });
}

function restoreOpener(event: Event): void {
  event.preventDefault();
  const target = opener;
  opener = null;
  window.requestAnimationFrame(() => {
    const fallback = document.querySelector<HTMLElement>(".workspace-main button:not([disabled]), .workspace-topbar button:not([disabled])");
    (target?.isConnected && target !== document.body ? target : fallback)?.focus();
  });
}
</script>

<template>
  <DialogRoot :open="open" :modal="true" @update:open="updateOpen">
    <DialogPortal disabled>
      <DialogOverlay class="modal-backdrop">
        <DialogContent class="modal" :class="{ 'modal-wide': wide }" @open-auto-focus="focusFirstField" @close-auto-focus="restoreOpener" @escape-key-down="blockClose" @pointer-down-outside="blockClose">
          <header class="modal-head">
            <DialogTitle as-child><h2>{{ title }}</h2></DialogTitle>
            <DialogClose as-child><button class="modal-close" type="button" :disabled="busy" aria-label="关闭"><AppIcon name="x" :size="15" /></button></DialogClose>
          </header>
          <DialogDescription as-child><p class="modal-note">{{ description }}</p></DialogDescription>
          <slot />
        </DialogContent>
      </DialogOverlay>
    </DialogPortal>
  </DialogRoot>
</template>
