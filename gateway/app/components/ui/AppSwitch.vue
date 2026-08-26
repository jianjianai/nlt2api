<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui";

withDefaults(defineProps<{
  modelValue: boolean;
  label: string;
  disabled?: boolean;
}>(), { disabled: false });

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <SwitchRoot
    class="switch"
    :class="{ on: modelValue }"
    :model-value="modelValue"
    :disabled="disabled"
    :aria-label="label"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <SwitchThumb class="switch-thumb" />
  </SwitchRoot>
</template>
