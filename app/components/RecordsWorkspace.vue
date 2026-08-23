<script setup lang="ts">
import { ref } from "vue";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "reka-ui";
import AppIcon from "./ui/AppIcon.vue";
import AppSwitch from "./ui/AppSwitch.vue";
import type { BodyPresentation, ConversationTrace, DebugRecordSummary, DisplayMessage, SidebarItem } from "../types/admin.ts";

const props = defineProps<{
  records: DebugRecordSummary[];
  filteredRecords: DebugRecordSummary[];
  sidebarItems: SidebarItem[];
  selectedRecordId: string | null;
  selectedTraceKey: string | null;
  selectedTrace?: ConversationTrace;
  selectedRequest: BodyPresentation | null;
  selectedResponse?: BodyPresentation | null;
  rawTraceKey: string | null;
  loadingDetail: boolean;
  recording: boolean;
  query: string;
  filter: "all" | "success" | "failed";
  failedCount: number;
  upstreamCallCount: number;
  toolFirstPassRate: number | null;
  toolAdapterCount: number;
  selectedRecordIndex: number;
  clearing: boolean;
}>();
const emit = defineEmits<{
  "update:query": [value: string];
  "update:filter": [value: "all" | "success" | "failed"];
  "update:rawTraceKey": [value: string | null];
  toggleRecording: [value: boolean];
  refresh: [];
  clear: [];
  selectRecord: [recordId: string, traceKey?: string];
  goto: [offset: number];
}>();

const expanded = ref(new Set<string>());
function traceRawKey(trace: ConversationTrace): string { return `raw:${trace.key}`; }
function messageAlign(role: string): "left" | "right" { return ["user", "tool"].includes(role) ? "right" : "left"; }
function overflows(message: DisplayMessage): boolean { return message.content.length > 4_000 || message.toolCalls.reduce((sum, call) => sum + call.name.length + call.arguments.length, 0) > 4_000; }
function toggleExpanded(key: string): void { const next = new Set(expanded.value); if (next.has(key)) next.delete(key); else next.add(key); expanded.value = next; }
function displayText(key: string, text: string): string { return expanded.value.has(key) || text.length <= 4_000 ? text : `${text.slice(0, 4_000)}\n…（内容过长，已截断）`; }
function compactTime(value: string): string { const date = new Date(value); const pad = (n: number) => String(n).padStart(2, "0"); const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; return date.toDateString() === new Date().toDateString() ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`; }
function toolModeLabel(value: string): string { return ({ auto: "自动", required: "必须调用", forced: "指定函数" } as Record<string, string>)[value] ?? value; }
function toolOutcomeLabel(value: string): string { return ({ tool_calls: "工具调用", final: "最终回复", invalid: "解析失败" } as Record<string, string>)[value] ?? value; }
</script>

<template>
  <section class="workspace-page records-workspace">
    <header class="page-heading page-heading-actions">
      <div><p class="section-kicker">请求诊断</p><h1>请求记录</h1><p>按客户端请求查看首次调用、重试、纠错和续写的完整链路。</p></div>
      <div class="page-actions">
        <label class="recording-control"><span>{{ recording ? "记录已开启" : "记录已关闭" }}</span><AppSwitch :model-value="recording" label="消息记录" @update:model-value="emit('toggleRecording', $event)" /></label>
        <button class="button button-quiet" type="button" @click="emit('refresh')"><AppIcon name="refresh-cw" :size="14" />刷新</button>
        <DropdownMenuRoot>
          <DropdownMenuTrigger class="icon-action more-trigger" aria-label="更多记录操作"><AppIcon name="more-horizontal" :size="16" /></DropdownMenuTrigger>
          <DropdownMenuPortal disabled>
            <DropdownMenuContent class="app-menu" align="end" :side-offset="6">
              <DropdownMenuItem class="app-menu-item danger" :disabled="!records.length || clearing" @select="emit('clear')"><AppIcon name="trash-2" :size="14" /><span>{{ clearing ? "清空中" : "清空全部记录" }}</span></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
    </header>
    <div class="records-toolbar"><label class="search-field"><AppIcon name="search" :size="14" /><span class="sr-only">搜索请求记录</span><input :value="query" type="search" placeholder="搜索端点、账号或模型" @input="emit('update:query', ($event.target as HTMLInputElement).value)" /></label><TabsRoot :model-value="filter" @update:model-value="emit('update:filter', $event as typeof filter)"><TabsList class="segmented-control" aria-label="记录状态筛选"><TabsTrigger value="all">全部 <span>{{ records.length }}</span></TabsTrigger><TabsTrigger value="success">成功 <span>{{ records.length - failedCount }}</span></TabsTrigger><TabsTrigger value="failed">失败 <span>{{ failedCount }}</span></TabsTrigger></TabsList></TabsRoot></div>
    <p class="records-meta">{{ recording ? "未来请求会写入调试记录" : "消息记录已关闭；开启后只记录未来请求" }} · {{ records.length }} 个客户端请求 · {{ upstreamCallCount }} 次上游调用<template v-if="toolFirstPassRate !== null"> · 工具调用首次解析 {{ toolFirstPassRate }}%（{{ toolAdapterCount }} 轮）</template></p>
    <div v-if="records.length === 0" class="workspace-empty"><strong>{{ recording ? "尚无请求记录" : "消息记录未开启" }}</strong><p>{{ recording ? "发送请求后，客户端与上游调用会显示在这里。" : "开启消息记录后，只会捕获未来请求；敏感认证字段会脱敏。" }}</p><button v-if="!recording" class="button button-primary" type="button" @click="emit('toggleRecording', true)">开启消息记录</button></div>
    <div v-else-if="filteredRecords.length === 0" class="workspace-empty"><strong>没有符合条件的记录</strong><button class="button button-quiet" type="button" @click="emit('update:filter', 'all'); emit('update:query', '')">清除筛选</button></div>
    <div v-else class="conversation-workbench">
      <aside class="trace-sidebar" aria-label="请求发送列表"><section v-for="item in sidebarItems" :key="item.record.id" class="trace-group" :class="{ active: selectedRecordId === item.record.id }"><button class="trace-record" type="button" :aria-current="selectedRecordId === item.record.id ? 'true' : undefined" @click="emit('selectRecord', item.record.id)"><span class="trace-record-top"><span class="status-chip" :class="item.record.status < 400 ? 'ok' : 'err'">{{ item.record.status }}</span><span class="trace-endpoint">{{ item.record.endpoint }}</span><time class="trace-time">{{ compactTime(item.record.at) }}</time></span><span class="trace-preview">{{ item.record.preview }}</span><span class="trace-record-sub"><span v-if="item.record.model" class="trace-model">{{ item.record.model }}</span>{{ item.record.accountLabel || "未分配账号" }}<template v-if="item.upstream.length"> · {{ item.upstream.length }} 次上游调用</template></span></button><div v-if="item.upstream.length" class="trace-children"><button v-for="child in item.upstream" :key="child.key" class="trace-child" :class="{ active: selectedTraceKey === child.key, failed: child.failed }" type="button" :aria-current="selectedTraceKey === child.key ? 'true' : undefined" @click="emit('selectRecord', item.record.id, child.key)"><span class="trace-child-title">{{ child.title }}</span><span class="trace-child-sub">{{ child.subtitle }} · HTTP {{ child.status }}</span></button></div></section></aside>
      <section v-if="selectedTrace" class="conversation-detail" :key="selectedTrace.key"><header class="conversation-header"><div class="conversation-heading"><div class="conversation-title-row"><span class="status-chip" :class="selectedTrace.status < 400 ? 'ok' : 'err'">{{ selectedTrace.status }}</span><h2>{{ selectedTrace.title }}</h2><span class="conversation-dir">{{ selectedTrace.direction === "client" ? "客户端会话" : "上游调用" }}</span></div><p class="conversation-meta">{{ new Date(selectedTrace.record.at).toLocaleString() }} · {{ selectedTrace.record.endpoint }} · {{ selectedTrace.subtitle }}</p></div><div class="conversation-actions"><div class="record-nav"><button type="button" aria-label="上一条记录" :disabled="selectedRecordIndex <= 0" @click="emit('goto', -1)"><AppIcon name="chevron-left" :size="14" /></button><button type="button" aria-label="下一条记录" :disabled="selectedRecordIndex < 0 || selectedRecordIndex >= filteredRecords.length - 1" @click="emit('goto', 1)"><AppIcon name="chevron-right" :size="14" /></button></div><button class="button button-quiet" type="button" @click="emit('update:rawTraceKey', rawTraceKey === traceRawKey(selectedTrace) ? null : traceRawKey(selectedTrace))">{{ rawTraceKey === traceRawKey(selectedTrace) ? "查看对话" : "原始数据" }}</button></div></header>
        <div v-if="rawTraceKey === traceRawKey(selectedTrace)" class="raw-trace"><section><h3>请求正文 · {{ selectedRequest?.contentType }}</h3><pre>{{ selectedRequest?.raw }}</pre></section><section v-if="selectedResponse"><h3>响应正文 · {{ selectedResponse.contentType }}</h3><pre>{{ selectedResponse.raw }}</pre></section></div>
        <div v-else class="chat-flow"><article v-for="(message, index) in selectedRequest?.messages ?? []" :key="`request-${index}`" class="chat-msg" :class="[messageAlign(message.role), { thinking: message.roleLabel === '思考' }]" ><div class="chat-role">{{ message.roleLabel }}</div><div class="chat-bubble"><div class="message-collapse" :class="{ expanded: expanded.has(`request-${index}`), 'has-overflow': overflows(message) }"><p v-if="message.content" class="message-content">{{ displayText(`request-${index}`, message.content) }}</p><div v-for="call in message.toolCalls" :key="call.id" class="tool-call-item"><span class="tool-call-name">工具：{{ call.name }}</span><code>{{ displayText(`request-${index}`, call.arguments) }}</code></div></div><button v-if="overflows(message)" class="expand-toggle" type="button" @click="toggleExpanded(`request-${index}`)">{{ expanded.has(`request-${index}`) ? "收起" : "展开全部" }}</button></div></article><div class="chat-divider"><span>{{ selectedTrace.direction === "client" ? "客户端响应" : "上游响应" }} · HTTP {{ selectedTrace.status }}</span></div><template v-if="selectedResponse"><article v-for="(message, index) in selectedResponse.messages" :key="`response-${index}`" class="chat-msg" :class="[messageAlign(message.role), { thinking: message.roleLabel === '思考' }]" ><div class="chat-role">{{ message.roleLabel }}</div><div class="chat-bubble"><div class="message-collapse" :class="{ expanded: expanded.has(`response-${index}`), 'has-overflow': overflows(message) }"><p v-if="message.content" class="message-content">{{ displayText(`response-${index}`, message.content) }}</p><div v-for="call in message.toolCalls" :key="call.id" class="tool-call-item"><span class="tool-call-name">工具：{{ call.name }}</span><code>{{ displayText(`response-${index}`, call.arguments) }}</code></div></div><button v-if="overflows(message)" class="expand-toggle" type="button" @click="toggleExpanded(`response-${index}`)">{{ expanded.has(`response-${index}`) ? "收起" : "展开全部" }}</button></div></article><p v-if="!selectedResponse.messages.length" class="parsed-empty">响应无消息内容。</p></template><p v-else class="parsed-empty">尚未收到响应正文。</p><p v-if="selectedTrace.error" class="trace-error">{{ selectedTrace.error }}</p><details v-if="selectedRequest?.fields.length" class="fold-section"><summary>请求参数 <span class="fold-count">{{ selectedRequest.fields.length }}</span></summary><dl class="record-fields"><template v-for="(field, index) in selectedRequest.fields" :key="`request-field-${index}`"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></template></dl></details><details v-if="selectedResponse?.fields.length" class="fold-section"><summary>响应元数据 <span class="fold-count">{{ selectedResponse.fields.length }}</span></summary><dl class="record-fields"><template v-for="(field, index) in selectedResponse.fields" :key="`response-field-${index}`"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></template></dl></details><details v-if="selectedTrace.record.toolCallAdapter" class="fold-section"><summary>工具调用转换 <span class="fold-count">{{ toolOutcomeLabel(selectedTrace.record.toolCallAdapter.finalOutcome) }}</span><span v-if="selectedTrace.record.toolCallAdapter.errors.length" class="fold-count fold-count-err">{{ selectedTrace.record.toolCallAdapter.errors.length }} 个错误</span></summary><dl class="record-fields"><dt>预期模式</dt><dd>{{ toolModeLabel(selectedTrace.record.toolCallAdapter.toolCallExpected) }}</dd><dt>首次结果</dt><dd>{{ toolOutcomeLabel(selectedTrace.record.toolCallAdapter.initialOutcome) }}</dd><dt>最终结果</dt><dd>{{ toolOutcomeLabel(selectedTrace.record.toolCallAdapter.finalOutcome) }}</dd><dt>修复次数</dt><dd>{{ selectedTrace.record.toolCallAdapter.repairAttempts }} / {{ selectedTrace.record.toolCallAdapter.maxRepairAttempts }}</dd></dl><ul v-if="selectedTrace.record.toolCallAdapter.errors.length" class="error-list"><li v-for="error in selectedTrace.record.toolCallAdapter.errors" :key="error">{{ error }}</li></ul></details></div>
      </section><section v-else-if="loadingDetail" class="conversation-detail"><div class="skeleton" style="height: 22px; width: 42%; margin: 18px 0 20px;"></div><div class="skeleton" style="height: 92px; margin-bottom: 12px;"></div><div class="skeleton" style="height: 92px; margin-bottom: 12px; width: 82%; margin-left: auto;"></div><div class="skeleton" style="height: 92px;"></div></section>
    </div>
  </section>
</template>
