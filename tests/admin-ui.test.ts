import assert from "node:assert/strict";
import test from "node:test";
import {
  confidenceLabel,
  deriveOverview,
  forecastConstraintLabel,
  formatMicroUsd,
  parseTheme,
  parseWorkspace,
  proxyPolicySummary,
  signedPercent,
} from "../app/utils/admin-ui.ts";
import type { Account, GatewayConfig, ProxyPoolEntry, ProxyPoolSettings, SchedulerRuntime } from "../app/types/admin.ts";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "account-1",
    label: "Kimi 主账号",
    email: "kimi@example.com",
    password: "secret",
    enabled: true,
    weight: 1,
    proxy: null,
    models: ["kimi-k3"],
    hasSession: true,
    sessionExpiresAt: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    runtime: {
      inFlight: 0,
      modelInFlight: {},
      requestsLastMinute: 0,
      modelCooldownUntil: {},
      consecutiveFailures: 0,
      cooldownUntil: 0,
    },
    ...overrides,
  };
}

test("parseTheme restores supported themes and defaults invalid values", () => {
  assert.equal(parseTheme("gray"), "gray");
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("violet"), "light");
  assert.equal(parseTheme(null), "light");
});

const config: GatewayConfig = {
  adminTokenConfigured: true,
  clientApiKeyRequired: false,
  clientApiKey: "client-key",
  defaultModel: "kimi-k3",
  minimumOutputTokens: 8_192,
  toolCallFormat: "auto",
  preambleVerbosity: "milestone",
};

const scheduler: SchedulerRuntime = { pending: 0, oldestWaitMs: 0, egresses: [] };

test("parseWorkspace restores only known workspaces", () => {
  assert.equal(parseWorkspace("overview"), "overview");
  assert.equal(parseWorkspace("settings"), "settings");
  assert.equal(parseWorkspace("legacy-tab"), "overview");
  assert.equal(parseWorkspace(null), "overview");
});

test("deriveOverview reports a healthy snapshot without invented alerts", () => {
  const proxies: ProxyPoolEntry[] = [{ id: "proxy-1", maskedUrl: "http://proxy.local:8080", kind: "http", status: "idle" }];
  const result = deriveOverview([account()], proxies, scheduler, config, Date.parse("2026-08-23T01:00:00.000Z"));
  assert.deepEqual(result.metrics.map((metric) => [metric.id, metric.value]), [
    ["accounts", "1/1"],
    ["proxies", "1/1"],
    ["traffic", "0"],
    ["issues", "0"],
  ]);
  assert.deepEqual(result.actions, []);
});

test("deriveOverview creates evidence-backed account, proxy, queue and API-key actions", () => {
  const now = Date.parse("2026-08-23T01:00:00.000Z");
  const cooling = account({
    runtime: {
      inFlight: 2,
      modelInFlight: { "kimi-k3": 1 },
      requestsLastMinute: 20,
      modelCooldownUntil: { "kimi-k3": now + 45_000 },
      consecutiveFailures: 2,
      cooldownUntil: now + 30_000,
      lastError: "rate limited",
    },
  });
  const proxies: ProxyPoolEntry[] = [{
    id: "proxy-error",
    maskedUrl: "socks5://us***@proxy.local:1080",
    kind: "socks5",
    status: "error",
    accountId: cooling.id,
    accountLabel: cooling.label,
    lastError: "Proxy connection was refused.",
  }];
  const result = deriveOverview(
    [cooling],
    proxies,
    { pending: 3, oldestWaitMs: 31_000, egresses: [] },
    { ...config, clientApiKey: "", clientApiKeyRequired: true },
    now,
  );
  assert.deepEqual(result.actions.map((item) => item.id), [
    "proxy:proxy-error",
    "account:account-1",
    "model:account-1:kimi-k3",
    "scheduler:queue",
    "settings:api-key",
  ]);
  assert.equal(result.metrics.find((metric) => metric.id === "traffic")?.value, "2");
  assert.equal(result.metrics.find((metric) => metric.id === "issues")?.value, "4");
});

test("analytics display helpers preserve money units and explain constraints", () => {
  assert.equal(formatMicroUsd(0), "$0.00");
  assert.equal(formatMicroUsd(12_840_000), "$12.84");
  assert.equal(formatMicroUsd(640), "$0.00064");
  assert.equal(forecastConstraintLabel("shared_egress_rpm"), "共享出口 RPM");
  assert.equal(confidenceLabel("low"), "低置信度");
  assert.equal(signedPercent(0.184), "+18%");
  assert.equal(signedPercent(-0.126), "-13%");
});

test("proxyPolicySummary names only enabled policies", () => {
  const settings: ProxyPoolSettings = {
    autoAssignOnAccountCreate: true,
    autoRotateOnTransportError: true,
    retryCurrentRequestAfterRotation: false,
    directFallbackWhenExhausted: false,
    defaultImportProtocol: "socks5",
    healthCheckTimeoutSeconds: 10,
    errorRetryCooldownSeconds: 300,
  };
  assert.equal(proxyPolicySummary(settings), "新增账号自动匹配 · 传输失败自动轮换");
  assert.equal(proxyPolicySummary({ ...settings, autoAssignOnAccountCreate: false, autoRotateOnTransportError: false }), "所有自动策略均已关闭");
});
