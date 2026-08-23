<script setup lang="ts">
import {
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "reka-ui";

withDefaults(defineProps<{
  text: string;
  side?: "top" | "right" | "bottom" | "left";
}>(), { side: "bottom" });
</script>

<template>
  <TooltipProvider :delay-duration="350" :skip-delay-duration="100">
    <TooltipRoot>
      <TooltipTrigger as-child><slot /></TooltipTrigger>
      <TooltipPortal disabled>
        <TooltipContent class="app-tooltip" :side="side" :side-offset="7">{{ text }}</TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
