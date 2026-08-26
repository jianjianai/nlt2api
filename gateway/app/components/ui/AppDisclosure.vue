<script setup lang="ts">
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
import AppIcon from "./AppIcon.vue";

withDefaults(defineProps<{
  open: boolean;
  title: string;
  description: string;
  openLabel?: string;
}>(), { openLabel: "配置" });

const emit = defineEmits<{ "update:open": [value: boolean] }>();
</script>

<template>
  <CollapsibleRoot class="configuration-section" :open="open" @update:open="emit('update:open', $event)">
    <CollapsibleTrigger class="disclosure-trigger">
      <span class="disclosure-copy"><strong>{{ title }}</strong><span>{{ description }}</span></span>
      <span class="disclosure-action">{{ open ? "收起" : openLabel }}<AppIcon name="chevron-down" :size="14" /></span>
    </CollapsibleTrigger>
    <CollapsibleContent class="configuration-body disclosure-content"><slot /></CollapsibleContent>
  </CollapsibleRoot>
</template>
