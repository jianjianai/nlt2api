<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import type { AppIconName } from "./ui/AppIcon.vue";
import type { OverviewSnapshot } from "../types/admin.ts";
import { poolTone, PROXY_STATUS_LABEL } from "../utils/admin-ui.ts";

const props = defineProps<{ overview: OverviewSnapshot | null }>();

interface Metric {
  key: string;
  label: string;
  value: string;
  hint: string;
  icon: AppIconName;
  tone: "good" | "warn" | "bad" | "";
}

const metrics = computed<Metric[]>(() => {
  const snapshot = props.overview;
  if (!snapshot) return [];
  const { available, target, total } = snapshot.tickets;
  return [
    {
      key: "tickets",
      label: "可用凭证对",
      value: `${available}`,
      hint: snapshot.demand.paused
        ? `池内共 ${total} · 无请求，铸票已暂停`
        : `目标水位 ${target} · 池内共 ${total}`,
      icon: "key",
      tone: snapshot.demand.paused ? "" : poolTone(available, target),
    },
    {
      key: "queue",
      label: "排队请求",
      value: `${snapshot.queue.waiting}`,
      hint: snapshot.queue.maxSize === 0
        ? "未启用排队，凭证不足直接返回 503"
        : `上限 ${snapshot.queue.maxSize} · 近 ${snapshot.demand.windowSeconds} 秒消耗 ${snapshot.demand.claims}`,
      icon: "activity",
      tone: snapshot.queue.waiting === 0 ? "" : snapshot.queue.waiting >= snapshot.queue.maxSize ? "bad" : "warn",
    },
    {
      key: "proxies",
      label: "可用出口 IP",
      value: `${snapshot.egress.usable}`,
      hint: `活跃 ${snapshot.proxies.active} · 限流冷却 ${snapshot.egress.rateLimited} · 可铸票 ${snapshot.proxiesMintable}`,
      icon: "globe",
      tone: snapshot.egress.usable === 0 ? "bad" : snapshot.egress.rateLimited > 0 ? "warn" : "good",
    },
    {
      key: "minters",
      label: "在线授权服务",
      value: `${snapshot.minters.online}`,
      hint: `进行中铸票 ${snapshot.minters.inflight}`,
      icon: "server",
      tone: snapshot.minters.online > 0 ? "good" : "bad",
    },
    {
      key: "rate",
      label: `近 ${snapshot.mintRate.windowMinutes} 分钟铸票`,
      value: `${snapshot.mintRate.minted}`,
      hint: `失败 ${snapshot.mintRate.failed}`,
      icon: "activity",
      tone: snapshot.mintRate.failed > snapshot.mintRate.minted ? "warn" : "",
    },
  ];
});

const issues = computed(() => {
  const snapshot = props.overview;
  if (!snapshot) return [] as Array<{ id: string; title: string; detail: string; tone: "warn" | "bad" }>;
  const list: Array<{ id: string; title: string; detail: string; tone: "warn" | "bad" }> = [];
  if (!snapshot.config.adminTokenConfigured) {
    list.push({ id: "admin", title: "未配置管理令牌", detail: "GATEWAY_ADMIN_TOKEN 为空，管理接口将拒绝所有请求。", tone: "bad" });
  }
  if (!snapshot.config.minterTokenConfigured) {
    list.push({ id: "minter", title: "未配置授权服务令牌", detail: "MINTER_TOKEN 为空，/ws/minter 一律拒绝连接。", tone: "bad" });
  }
  if (snapshot.config.allowAnonymous) {
    list.push({ id: "anon", title: "转发端点允许匿名访问", detail: "GATEWAY_ALLOW_ANONYMOUS=true，任何人都可调用 /v1 接口。", tone: "bad" });
  } else if (!snapshot.config.apiKeyConfigured) {
    list.push({ id: "apikey", title: "未配置客户端密钥", detail: "GATEWAY_API_KEY 为空，/v1 接口会返回 503。", tone: "warn" });
  }
  if (snapshot.minters.online === 0) {
    list.push({ id: "offline", title: "没有在线授权服务", detail: "凭证池无法补充，池耗尽后转发将返回 503。", tone: "bad" });
  }  if (snapshot.proxies.active === 0) {
    list.push({ id: "noproxy", title: "没有活跃代理", detail: "先导入代理并等待测活通过。", tone: "bad" });
  } else if (snapshot.proxiesMintable === 0) {
    list.push({ id: "nomintable", title: "活跃代理均无法用于铸票", detail: "带认证的 SOCKS 代理无法驱动浏览器，请补充 HTTP 代理。", tone: "warn" });
  }
  if (snapshot.egress.usable === 0 && snapshot.proxies.active > 0) {
    list.push({ id: "allthrottled", title: "所有出口都在限流冷却中", detail: "上游按出口 IP 限流，当前无可用 IP。扩充代理数量是唯一有效的缓解手段。", tone: "bad" });
  } else if (snapshot.egress.rateLimited > 0) {
    list.push({
      id: "throttled",
      title: `${snapshot.egress.rateLimited} 个出口正在限流冷却`,
      detail: "这些 IP 遭上游 429，已暂停使用并自动转向其他出口。频繁出现说明代理数量相对流量偏少。",
      tone: "warn",
    });
  }
  if (!snapshot.demand.paused && snapshot.tickets.available < snapshot.tickets.target && snapshot.minters.online > 0) {
    list.push({ id: "lowwater", title: "凭证水位低于目标", detail: "补充任务已下发，若长期不恢复请检查授权服务日志。", tone: "warn" });
  }
  if (snapshot.queue.waiting > 0) {
    list.push({
      id: "queue",
      title: `${snapshot.queue.waiting} 个请求正在排队`,
      detail: "铸票速度跟不上消耗，可提高备货时长或补充可铸票代理。",
      tone: snapshot.queue.maxSize > 0 && snapshot.queue.waiting >= snapshot.queue.maxSize ? "bad" : "warn",
    });
  }
  return list;
});
</script>

<template>
  <section class="workspace-page">
    <header class="page-heading">
      <div>
        <p class="section-kicker">运行状态</p>
        <h1>概览</h1>
        <p>凭证对池由在线授权服务补充；每组凭证与铸造它的代理成对使用。</p>
      </div>
    </header>

    <div v-if="metrics.length" class="overview-metrics">
      <article v-for="metric in metrics" :key="metric.key" :class="metric.tone ? `tone-${metric.tone}` : ''">
        <div class="metric-head"><span>{{ metric.label }}</span><AppIcon :name="metric.icon" :size="15" /></div>
        <strong>{{ metric.value }}</strong>
        <small>{{ metric.hint }}</small>
      </article>
    </div>
    <div v-else class="mini-empty">正在加载运行状态…</div>

    <section class="content-section">
      <div class="section-heading">
        <div><h2>待处理事项</h2><p>影响转发可用性的配置与资源问题。</p></div>
      </div>
      <div v-if="issues.length === 0 && overview" class="status-empty">
        <span aria-hidden="true">✓</span>
        <div><strong>一切正常</strong><p>代理、凭证与授权服务均处于可用状态。</p></div>
      </div>
      <ul v-else class="action-list">
        <li v-for="issue in issues" :key="issue.id" :class="issue.tone === 'bad' ? 'tone-bad' : ''">
          <span class="action-indicator" aria-hidden="true"></span>
          <div><strong>{{ issue.title }}</strong><p>{{ issue.detail }}</p></div>
        </li>
      </ul>
    </section>

    <section v-if="overview" class="content-section">
      <div class="section-heading"><div><h2>代理状态分布</h2><p>只有活跃代理会被授权服务领取。</p></div></div>
      <div class="overview-table">
        <div v-for="(count, status) in overview.proxies" :key="status" class="overview-row">
          <div><strong>{{ PROXY_STATUS_LABEL[status] }}</strong><span>{{ status }}</span></div>
          <span class="mono">{{ count }}</span>
        </div>
      </div>
    </section>
  </section>
</template>
