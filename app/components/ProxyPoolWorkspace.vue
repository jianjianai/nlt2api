<script setup lang="ts">
import { computed, ref } from "vue";
import AppDisclosure from "./ui/AppDisclosure.vue";
import AppIcon from "./ui/AppIcon.vue";
import AppSwitch from "./ui/AppSwitch.vue";
import type { ProxyImportLineResult, ProxyPoolEntry, ProxyPoolSettings, ProxyPoolStatus } from "../types/admin.ts";
import { proxyPolicySummary } from "../utils/admin-ui.ts";

const props = defineProps<{
  proxies: ProxyPoolEntry[];
  draft: ProxyPoolSettings;
  importText: string;
  importResults: ProxyImportLineResult[];
  filter: "all" | ProxyPoolStatus;
  busyIds: Set<string>;
  directAccountCount: number;
  importing: boolean;
  checkingAll: boolean;
  assigningDirect: boolean;
  saving: boolean;
}>();
const emit = defineEmits<{
  "update:importText": [value: string];
  "update:filter": [value: "all" | ProxyPoolStatus];
  updatePolicy: [field: keyof ProxyPoolSettings, value: boolean | number | string];
  import: [];
  check: [proxy: ProxyPoolEntry];
  checkMany: [scope: "error" | "all"];
  assignDirect: [];
  delete: [proxy: ProxyPoolEntry];
  savePolicies: [];
}>();

const policiesOpen = ref(false);
const importOpen = ref(false);
const counts = computed(() => ({
  all: props.proxies.length,
  idle: props.proxies.filter((proxy) => proxy.status === "idle").length,
  in_use: props.proxies.filter((proxy) => proxy.status === "in_use").length,
  error: props.proxies.filter((proxy) => proxy.status === "error").length,
  checking: props.proxies.filter((proxy) => proxy.status === "checking").length,
}));
const filtered = computed(() => props.filter === "all" ? props.proxies : props.proxies.filter((proxy) => proxy.status === props.filter));
const statusLabel: Record<ProxyPoolStatus, string> = { idle: "空闲", in_use: "使用中", error: "错误", checking: "检测中" };
const outcomeLabel = { created: "已新增", existing: "已存在", invalid: "格式错误" } as const;

function setPolicy(field: keyof ProxyPoolSettings, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  emit("updatePolicy", field, target instanceof HTMLInputElement && target.type === "number" ? Number(target.value) : target.value);
}
</script>

<template>
  <section class="workspace-page proxy-workspace">
    <header class="page-heading page-heading-actions"><div><p class="section-kicker">出口资源</p><h1>代理池</h1><p>导入、测活并分配代理；传输失败时按策略自动轮换。</p></div><div class="page-actions"><button class="button button-primary" type="button" :disabled="assigningDirect || directAccountCount === 0 || counts.idle === 0" :aria-busy="assigningDirect" :title="directAccountCount === 0 ? '当前没有直连账号' : counts.idle === 0 ? '当前没有健康空闲代理' : `为最多 ${Math.min(directAccountCount, counts.idle)} 个直连账号分配代理`" @click="emit('assignDirect')"><span v-if="assigningDirect" class="spinner" aria-hidden="true"></span><AppIcon v-else name="users" :size="14" />{{ assigningDirect ? "分配中" : `分配直连账号 (${Math.min(directAccountCount, counts.idle)})` }}</button><button class="button button-quiet" type="button" :disabled="checkingAll" :aria-busy="checkingAll" @click="emit('checkMany', 'error')"><span v-if="checkingAll" class="spinner" aria-hidden="true"></span><AppIcon v-else name="refresh-cw" :size="14" />{{ checkingAll ? "检测中" : "重测错误" }}</button><button class="button button-quiet" type="button" :disabled="checkingAll" @click="emit('checkMany', 'all')"><AppIcon name="activity" :size="14" />测活全部</button></div></header>

    <div class="resource-summary" aria-label="代理池状态"><button v-for="item in [{ id: 'all', label: '全部' }, { id: 'idle', label: '空闲' }, { id: 'in_use', label: '使用中' }, { id: 'error', label: '错误' }, { id: 'checking', label: '检测中' }]" :key="item.id" type="button" :class="{ active: filter === item.id }" :aria-pressed="filter === item.id" @click="emit('update:filter', item.id as typeof filter)"><span>{{ item.label }}</span><strong>{{ counts[item.id as keyof typeof counts] }}</strong></button></div>

    <AppDisclosure v-model:open="policiesOpen" title="自动化策略" :description="proxyPolicySummary(draft)"><div class="policy-grid"><label class="toggle-field"><span><strong>新增账号自动匹配</strong><small>未手工填写代理时，从健康空闲池分配。</small></span><AppSwitch :model-value="draft.autoAssignOnAccountCreate" label="新增账号自动匹配" @update:model-value="emit('updatePolicy', 'autoAssignOnAccountCreate', $event)" /></label><label class="toggle-field"><span><strong>代理错误自动轮换</strong><small>仅连接、DNS、TLS、鉴权和超时等传输错误。</small></span><AppSwitch :model-value="draft.autoRotateOnTransportError" label="代理错误自动轮换" @update:model-value="emit('updatePolicy', 'autoRotateOnTransportError', $event)" /></label><label class="toggle-field"><span><strong>轮换后重试当前请求</strong><small>新代理测活并绑定后，当前请求最多重试一次。</small></span><AppSwitch :model-value="draft.retryCurrentRequestAfterRotation" label="轮换后重试当前请求" @update:model-value="emit('updatePolicy', 'retryCurrentRequestAfterRotation', $event)" /></label><label class="toggle-field"><span><strong>耗尽时回退直连</strong><small>没有健康代理时解除故障代理并改为直连。</small></span><AppSwitch :model-value="draft.directFallbackWhenExhausted" label="耗尽时回退直连" @update:model-value="emit('updatePolicy', 'directFallbackWhenExhausted', $event)" /></label></div><div class="field-grid"><label><span>无协议默认类型</span><select :value="draft.defaultImportProtocol" @change="setPolicy('defaultImportProtocol', $event)"><option value="http">HTTP</option><option value="socks5">SOCKS5</option><option value="socks4">SOCKS4</option></select></label><label><span>测活超时（秒）</span><input :value="draft.healthCheckTimeoutSeconds" type="number" min="1" max="120" @change="setPolicy('healthCheckTimeoutSeconds', $event)" /></label><label><span>错误重测冷却（秒）</span><input :value="draft.errorRetryCooldownSeconds" type="number" min="1" max="86400" @change="setPolicy('errorRetryCooldownSeconds', $event)" /></label></div><div class="form-actions"><button class="button button-primary" type="button" :disabled="saving" :aria-busy="saving" @click="emit('savePolicies')"><span v-if="saving" class="spinner" aria-hidden="true"></span><AppIcon v-else name="check" :size="14" />{{ saving ? "保存中" : "保存策略" }}</button></div></AppDisclosure>

    <AppDisclosure v-model:open="importOpen" title="批量导入" description="一行一个；支持完整 URL、host:port 和带鉴权简写。" open-label="展开"><label class="stacked-field"><span>代理列表</span><textarea :value="importText" rows="7" spellcheck="false" placeholder="proxy.example:8080&#10;proxy.example:1080:user:pass&#10;user:pass@proxy.example:1080&#10;socks5://user:pass@proxy.example:1080" @input="emit('update:importText', ($event.target as HTMLTextAreaElement).value)"></textarea><small>无协议行按 {{ draft.defaultImportProtocol.toUpperCase() }} 解析；IPv6 使用 [地址]:端口。</small></label><div class="form-actions"><button class="button button-primary" type="button" :disabled="importing || !importText.trim()" :aria-busy="importing" @click="emit('import')"><span v-if="importing" class="spinner" aria-hidden="true"></span><AppIcon v-else name="plus" :size="14" />{{ importing ? "导入中" : "导入代理" }}</button></div><ul v-if="importResults.length" class="import-result-list"><li v-for="result in importResults" :key="`${result.line}-${result.source}`" :class="result.status"><strong>第 {{ result.line }} 行 · {{ outcomeLabel[result.status] }}</strong><span>{{ result.source }}</span><small v-if="result.error">{{ result.error }}</small></li></ul></AppDisclosure>

    <section class="content-section proxy-list-section"><div class="section-heading"><div><h2>代理列表</h2><p>{{ filtered.length }} 个代理符合当前筛选。</p></div></div><div v-if="proxies.length === 0" class="workspace-empty"><strong>代理池为空</strong><p>导入代理后，账号可自动或手工分配健康出口。</p><button class="button button-primary" type="button" @click="importOpen = true"><AppIcon name="plus" :size="14" />导入代理</button></div><div v-else-if="filtered.length === 0" class="workspace-empty"><strong>没有符合筛选的代理</strong><button class="button button-quiet" type="button" @click="emit('update:filter', 'all')">清除筛选</button></div><div v-else class="proxy-resource-list"><article v-for="proxy in filtered" :id="`proxy-${proxy.id}`" :key="proxy.id"><div class="proxy-address"><span class="badge" :class="proxy.status === 'error' ? 'bad' : proxy.status === 'checking' ? 'warn' : proxy.status === 'in_use' ? 'good' : 'muted'">{{ statusLabel[proxy.status] }}</span><code>{{ proxy.maskedUrl }}</code></div><dl><div><dt>协议</dt><dd>{{ proxy.kind.toUpperCase() }}</dd></div><div><dt>绑定账号</dt><dd>{{ proxy.accountLabel || "-" }}</dd></div><div><dt>最后测活</dt><dd>{{ proxy.lastCheckedAt ? new Date(proxy.lastCheckedAt).toLocaleString() : "-" }}</dd></div><div><dt>下次重测</dt><dd>{{ proxy.retryAfter ? new Date(proxy.retryAfter).toLocaleString() : "-" }}</dd></div></dl><p v-if="proxy.lastError" class="inline-error">{{ proxy.lastError }}</p><footer><button class="button button-quiet" type="button" :disabled="busyIds.has(proxy.id)" :aria-busy="busyIds.has(proxy.id)" @click="emit('check', proxy)"><span v-if="busyIds.has(proxy.id)" class="spinner" aria-hidden="true"></span><AppIcon v-else name="activity" :size="13" />{{ busyIds.has(proxy.id) ? "检测中" : "测活" }}</button><button class="button button-danger" type="button" :disabled="Boolean(proxy.accountId) || proxy.status === 'checking' || busyIds.has(proxy.id)" :title="proxy.accountId ? '绑定账号的代理不能删除' : proxy.status === 'checking' ? '检测中的代理不能删除' : '删除代理'" @click="emit('delete', proxy)"><AppIcon name="trash-2" :size="13" />删除</button></footer></article></div></section>
  </section>
</template>
