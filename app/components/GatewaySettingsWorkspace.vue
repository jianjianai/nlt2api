<script setup lang="ts">
import SecretValue from "./ui/SecretValue.vue";
import type { GatewayConfig, GatewaySettings, PreambleVerbosity, ToolCallFormat } from "../types/admin.ts";

const props = defineProps<{
  settings: GatewaySettings;
  config: GatewayConfig;
  allModels: string[];
  minimumOutputTokensDraft: number;
  savingBudget: boolean;
  secretResetToken: number;
  copySecret: (value: string, label: string) => void | Promise<void>;
}>();
const emit = defineEmits<{
  "update:minimumOutputTokensDraft": [value: number];
  saveBudget: [];
  setToolFormat: [value: ToolCallFormat];
  setPreamble: [value: PreambleVerbosity];
  setModelToolFormat: [model: string, value: string];
  setModelPreamble: [model: string, value: string];
  signOut: [];
}>();

const effectiveFormat = () => props.settings.toolCallFormat ?? props.config.toolCallFormat ?? "auto";
const effectivePreamble = () => props.settings.preambleVerbosity ?? props.config.preambleVerbosity ?? "milestone";
</script>

<template>
  <section class="workspace-page gateway-settings-workspace">
    <header class="page-heading"><div><p class="section-kicker">全局配置</p><h1>网关设置</h1><p>管理客户端访问、生成预算和工具调用协议。</p></div></header>
    <section class="content-section settings-group"><div class="section-heading"><div><h2>管理会话</h2><p>退出会清除当前浏览器中的管理员令牌和已显示的敏感值。</p></div></div><button class="button button-danger" type="button" @click="emit('signOut')">退出管理面板</button></section>
    <section class="content-section settings-group"><div class="section-heading"><div><h2>外部访问</h2><p>客户端调用 OpenAI 兼容接口时使用的 API Key。</p></div></div><div class="secret-setting"><span>客户端 API Key</span><SecretValue :value="config.clientApiKey" label="客户端 API Key" :reset-token="secretResetToken" :copy="copySecret" /><small>{{ config.clientApiKeyRequired ? "客户端认证已启用。" : "当前客户端入口未强制使用 API Key。" }}</small></div></section>
    <section class="content-section settings-group"><div class="section-heading"><div><h2>生成预算</h2><p>为推理模型保留足够的上游单轮输出空间。</p></div></div><div class="field-grid"><label><span>最小上游输出预算</span><div class="field-action"><input :value="minimumOutputTokensDraft" type="number" min="0" max="8192" @input="emit('update:minimumOutputTokensDraft', Number(($event.target as HTMLInputElement).value))" /><button class="button button-quiet" type="button" :disabled="savingBudget" @click="emit('saveBudget')">{{ savingBudget ? "保存中…" : "保存" }}</button></div><small>0 表示完全尊重客户端预算；其他值作为每轮上游最小预算。</small></label></div></section>
    <section class="content-section settings-group"><div class="section-heading"><div><h2>工具调用协议</h2><p>按模型覆盖优先于全局设置；解析端始终同时接受 JSON 与 XML。</p></div></div><div class="field-grid"><label><span>全局信封格式</span><select :value="effectiveFormat()" @change="emit('setToolFormat', ($event.target as HTMLSelectElement).value as ToolCallFormat)"><option value="auto">auto · 模型自选</option><option value="json">json · JSON 信封</option><option value="xml">xml · XML 信封</option></select></label><label><span>进度播报</span><select :value="effectivePreamble()" @change="emit('setPreamble', ($event.target as HTMLSelectElement).value as PreambleVerbosity)"><option value="milestone">milestone · 里程碑播报</option><option value="normal">normal · 关键步骤播报</option><option value="verbose">verbose · 逐步播报</option><option value="quiet">quiet · 静默</option></select><small>只影响用户可见进度播报，不改变模型能力或工具执行。</small></label></div><div class="model-override-list"><div class="model-override-head"><span>模型</span><span>信封格式</span><span>播报档位</span></div><div v-for="model in allModels" :key="model" class="model-override-row"><code>{{ model }}</code><select :value="settings.modelToolCallFormats?.[model] ?? ''" @change="emit('setModelToolFormat', model, ($event.target as HTMLSelectElement).value)"><option value="">跟随全局（{{ effectiveFormat() }}）</option><option value="auto">auto</option><option value="json">json</option><option value="xml">xml</option></select><select :value="settings.modelPreambleVerbosities?.[model] ?? ''" @change="emit('setModelPreamble', model, ($event.target as HTMLSelectElement).value)"><option value="">跟随全局（{{ effectivePreamble() }}）</option><option value="milestone">milestone</option><option value="normal">normal</option><option value="verbose">verbose</option><option value="quiet">quiet</option></select></div><div v-if="!allModels.length" class="mini-empty">暂无已配置模型；请先在账号中获取或编辑模型列表。</div></div></section>
  </section>
</template>
