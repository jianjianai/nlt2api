import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getProxyConfig } from "~/server/utils/config.ts";
import { canonicalProxy, egressIdentity } from "~/server/utils/proxy.ts";;
import { DEFAULT_PROXY_POOL_SETTINGS, DEFAULT_PROXY_SYNC_SETTINGS, DEFAULT_SCHEDULER_SETTINGS } from "~/server/utils/types.ts";
import type {
  AccountGroup,
  AccountSchedulerOverrides,
  DebugRecord,
  DebugRecordSummary,
  GroupApiKey,
  ManagedAccount,
  PersistentState,
  ProxyKind,
  ProxyPoolEntry,
  ProxyPoolSettings,
  ProxySettings,
  ProxySyncRun,
  ProxySyncSettings,
  SchedulerSettings,
} from "~/server/utils/types.ts";

const STORE_FILE = "accounts.json";
const RECORDS_DIR = "records";
const RECORD_INDEX_FILE = "records-index.json";
const MAX_DEBUG_RECORDS = 500;

interface RecordIndexEntry {
  summary: DebugRecordSummary;
  file: string;
}

function emptyState(): PersistentState {
  return {
    version: 4,
    settings: {
      recordMessages: false,
      scheduler: { ...DEFAULT_SCHEDULER_SETTINGS },
      proxyPool: { ...DEFAULT_PROXY_POOL_SETTINGS },
      proxySync: { ...DEFAULT_PROXY_SYNC_SETTINGS },
    },
    accounts: [],
    proxyPool: [],
    accountGroups: [],
    groupApiKeys: [],
    proxySyncRuns: [],
  };
}

function normaliseToolCallFormat(value: unknown): "auto" | "json" | "xml" | undefined {
  return value === "auto" || value === "json" || value === "xml" ? value : undefined;
}

function normalisePreambleVerbosity(value: unknown): "quiet" | "normal" | "verbose" | "milestone" | undefined {
  return value === "quiet" || value === "normal" || value === "verbose" || value === "milestone" ? value : undefined;
}

function normaliseMinimumOutputTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 8_192
    ? value
    : undefined;
}

function normaliseModelToolCallFormats(value: unknown): Record<string, "auto" | "json" | "xml"> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, "auto" | "json" | "xml"> = {};
  for (const [key, format] of Object.entries(value)) {
    const model = key.trim();
    const normalised = normaliseToolCallFormat(format);
    if (model && normalised) {
      result[model] = normalised;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normaliseModelPreambleVerbosities(value: unknown): Record<string, "quiet" | "normal" | "verbose" | "milestone"> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, "quiet" | "normal" | "verbose" | "milestone"> = {};
  for (const [key, verbosity] of Object.entries(value)) {
    const model = key.trim();
    const normalised = normalisePreambleVerbosity(verbosity);
    if (model && normalised) {
      result[model] = normalised;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Accepted settings mutations. `undefined` leaves a field untouched; `null`
 * (or an empty map) clears it, returning to the env-configured default.
 */
export interface ProxySettingsUpdate {
  recordMessages?: boolean;
  scheduler?: Partial<SchedulerSettings>;
  proxyPool?: Partial<ProxyPoolSettings>;
  minimumOutputTokens?: number;
  toolCallFormat?: "auto" | "json" | "xml" | null;
  preambleVerbosity?: "quiet" | "normal" | "verbose" | "milestone" | null;
  modelToolCallFormats?: Record<string, "auto" | "json" | "xml"> | null;
  modelPreambleVerbosities?: Record<string, "quiet" | "normal" | "verbose" | "milestone"> | null;
}

/** Drop unknown/invalid persisted settings while preserving every valid one. */
function normaliseBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function normaliseSchedulerSettings(value: unknown): SchedulerSettings {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    accountModelConcurrency: normaliseBoundedInteger(parsed.accountModelConcurrency, DEFAULT_SCHEDULER_SETTINGS.accountModelConcurrency, 1, 1_000),
    accountRpm: normaliseBoundedInteger(parsed.accountRpm, DEFAULT_SCHEDULER_SETTINGS.accountRpm, 1, 100_000),
    proxyRpm: normaliseBoundedInteger(parsed.proxyRpm, DEFAULT_SCHEDULER_SETTINGS.proxyRpm, 1, 100_000),
    directEgressLimitEnabled: typeof parsed.directEgressLimitEnabled === "boolean"
      ? parsed.directEgressLimitEnabled
      : DEFAULT_SCHEDULER_SETTINGS.directEgressLimitEnabled,
    directEgressRpm: normaliseBoundedInteger(parsed.directEgressRpm, DEFAULT_SCHEDULER_SETTINGS.directEgressRpm, 1, 100_000),
    stickyTtlSeconds: normaliseBoundedInteger(parsed.stickyTtlSeconds, DEFAULT_SCHEDULER_SETTINGS.stickyTtlSeconds, 1, 604_800),
    queueTimeoutSeconds: normaliseBoundedInteger(parsed.queueTimeoutSeconds, DEFAULT_SCHEDULER_SETTINGS.queueTimeoutSeconds, 0, 86_400),
    maxQueueSize: normaliseBoundedInteger(parsed.maxQueueSize, DEFAULT_SCHEDULER_SETTINGS.maxQueueSize, 0, 100_000),
  };
}

function accountEgressKey(proxy: string | undefined): string {
  return egressIdentity(proxy).key;
}

function assertUniqueAccountEgress(accounts: readonly ManagedAccount[], candidate: ManagedAccount, ignoreId?: string): void {
  const key = accountEgressKey(candidate.proxy);
  const duplicate = accounts.find((account) => account.id !== ignoreId && accountEgressKey(account.proxy) === key);
  if (duplicate) {
    throw new Error(`Egress is already assigned to account "${duplicate.label}"; one IP may serve only one account.`);
  }
}

function normaliseAccountSchedulerOverrides(value: unknown, models: string[]): AccountSchedulerOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const parsed = value as Record<string, unknown>;
  const result: AccountSchedulerOverrides = {};
  if (typeof parsed.accountRpm === "number" && Number.isInteger(parsed.accountRpm) && parsed.accountRpm >= 1 && parsed.accountRpm <= 100_000) {
    result.accountRpm = parsed.accountRpm;
  }
  if (typeof parsed.accountModelConcurrency === "number" && Number.isInteger(parsed.accountModelConcurrency)
    && parsed.accountModelConcurrency >= 1 && parsed.accountModelConcurrency <= 1_000) {
    result.accountModelConcurrency = parsed.accountModelConcurrency;
  }
  if (parsed.modelConcurrency && typeof parsed.modelConcurrency === "object" && !Array.isArray(parsed.modelConcurrency)) {
    const supported = new Set(models);
    const modelConcurrency: Record<string, number> = {};
    for (const [rawModel, entry] of Object.entries(parsed.modelConcurrency)) {
      const model = rawModel.trim();
      if (supported.has(model) && typeof entry === "number" && Number.isInteger(entry) && entry >= 1 && entry <= 1_000) {
        modelConcurrency[model] = entry;
      }
    }
    if (Object.keys(modelConcurrency).length > 0) {
      result.modelConcurrency = modelConcurrency;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normaliseProxySyncSettings(value: unknown): ProxySyncSettings {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_PROXY_SYNC_SETTINGS.enabled,
    intervalMinutes: normaliseBoundedInteger(parsed.intervalMinutes, DEFAULT_PROXY_SYNC_SETTINGS.intervalMinutes, 5, 1_440),
    targetAccountCount: normaliseBoundedInteger(parsed.targetAccountCount, DEFAULT_PROXY_SYNC_SETTINGS.targetAccountCount, 0, 500),
    candidateLimit: normaliseBoundedInteger(parsed.candidateLimit, DEFAULT_PROXY_SYNC_SETTINGS.candidateLimit, 1, 2_000),
    probeConcurrency: normaliseBoundedInteger(parsed.probeConcurrency, DEFAULT_PROXY_SYNC_SETTINGS.probeConcurrency, 1, 100),
    probeTimeoutSeconds: normaliseBoundedInteger(parsed.probeTimeoutSeconds, DEFAULT_PROXY_SYNC_SETTINGS.probeTimeoutSeconds, 1, 120),
    failureThreshold: normaliseBoundedInteger(parsed.failureThreshold, DEFAULT_PROXY_SYNC_SETTINGS.failureThreshold, 1, 20),
    archiveCooldownHours: normaliseBoundedInteger(parsed.archiveCooldownHours, DEFAULT_PROXY_SYNC_SETTINGS.archiveCooldownHours, 1, 8_760),
  };
}

function normaliseProxyPoolSettings(value: unknown): ProxyPoolSettings {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const protocol = parsed.defaultImportProtocol;
  return {
    autoAssignOnAccountCreate: typeof parsed.autoAssignOnAccountCreate === "boolean"
      ? parsed.autoAssignOnAccountCreate
      : DEFAULT_PROXY_POOL_SETTINGS.autoAssignOnAccountCreate,
    autoRotateOnTransportError: typeof parsed.autoRotateOnTransportError === "boolean"
      ? parsed.autoRotateOnTransportError
      : DEFAULT_PROXY_POOL_SETTINGS.autoRotateOnTransportError,
    retryCurrentRequestAfterRotation: typeof parsed.retryCurrentRequestAfterRotation === "boolean"
      ? parsed.retryCurrentRequestAfterRotation
      : DEFAULT_PROXY_POOL_SETTINGS.retryCurrentRequestAfterRotation,
    directFallbackWhenExhausted: typeof parsed.directFallbackWhenExhausted === "boolean"
      ? parsed.directFallbackWhenExhausted
      : DEFAULT_PROXY_POOL_SETTINGS.directFallbackWhenExhausted,
    defaultImportProtocol: protocol === "http" || protocol === "socks4" || protocol === "socks5"
      ? protocol
      : DEFAULT_PROXY_POOL_SETTINGS.defaultImportProtocol,
    healthCheckTimeoutSeconds: normaliseBoundedInteger(parsed.healthCheckTimeoutSeconds, DEFAULT_PROXY_POOL_SETTINGS.healthCheckTimeoutSeconds, 1, 120),
    errorRetryCooldownSeconds: normaliseBoundedInteger(parsed.errorRetryCooldownSeconds, DEFAULT_PROXY_POOL_SETTINGS.errorRetryCooldownSeconds, 1, 86_400),
  };
}

function normaliseProxyPool(value: unknown): ProxyPoolEntry[] {
  if (!Array.isArray(value)) return [];
  const result: ProxyPoolEntry[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.url !== "string") continue;
    try {
      const canonical = canonicalProxy(entry.url);
      if (ids.has(entry.id) || urls.has(canonical.url)) continue;
      const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString();
      const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : createdAt;
      const normalized: ProxyPoolEntry = {
        id: entry.id,
        url: canonical.url,
        kind: canonical.kind,
        source: entry.source === "rola_free" ? "rola_free" : "manual",
        lifecycle: entry.lifecycle === "failed" || entry.lifecycle === "archived" ? entry.lifecycle : "active",
        failureCount: normaliseBoundedInteger(entry.failureCount, 0, 0, 1_000_000),
        createdAt,
        updatedAt,
        ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim().slice(0, 120) } : {}),
        ...(typeof entry.lastCheckedAt === "string" ? { lastCheckedAt: entry.lastCheckedAt } : {}),
        ...(typeof entry.lastHealthyAt === "string" ? { lastHealthyAt: entry.lastHealthyAt } : {}),
        ...(typeof entry.lastError === "string" && entry.lastError ? { lastError: entry.lastError.slice(0, 300) } : {}),
        ...(typeof entry.failedAt === "string" ? { failedAt: entry.failedAt } : {}),
        ...(typeof entry.archivedAt === "string" ? { archivedAt: entry.archivedAt } : {}),
        ...(typeof entry.retryAfter === "number" && Number.isFinite(entry.retryAfter) && entry.retryAfter > 0 ? { retryAfter: entry.retryAfter } : {}),
      };
      ids.add(normalized.id);
      urls.add(normalized.url);
      result.push(normalized);
    } catch {
      // Invalid persisted proxies are dropped without affecting valid accounts.
    }
  }
  return result;
}

function normaliseProxySyncRuns(value: unknown): ProxySyncRun[] {
  if (!Array.isArray(value)) return [];
  const runs: ProxySyncRun[] = [];
  for (const raw of value.slice(-100)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const run = raw as Record<string, unknown>;
    if (typeof run.id !== "string" || (run.trigger !== "manual" && run.trigger !== "scheduled")) continue;
    const status = run.status === "running" ? "interrupted" : run.status;
    if (status !== "completed" && status !== "failed" && status !== "interrupted") continue;
    const countsSource = run.counts && typeof run.counts === "object" && !Array.isArray(run.counts) ? run.counts as Record<string, unknown> : {};
    const count = (key: string) => normaliseBoundedInteger(countsSource[key], 0, 0, 1_000_000);
    runs.push({
      id: run.id,
      trigger: run.trigger,
      status,
      startedAt: typeof run.startedAt === "string" ? run.startedAt : new Date(0).toISOString(),
      ...(typeof run.completedAt === "string" ? { completedAt: run.completedAt } : {}),
      sourceUrl: typeof run.sourceUrl === "string" ? run.sourceUrl : "https://rola-ip.co/zh/tools/free-proxy-list",
      counts: {
        fetched: count("fetched"), parsed: count("parsed"), skipped: count("skipped"), probed: count("probed"),
        healthy: count("healthy"), failed: count("failed"), replaced: count("replaced"), archived: count("archived"), created: count("created"),
      },
      details: Array.isArray(run.details) ? run.details.slice(-2_000) as ProxySyncRun["details"] : [],
      ...(typeof run.error === "string" ? { error: run.error.slice(0, 500) } : {}),
    });
  }
  return runs;
}

function normaliseSettings(value: unknown): ProxySettings {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const minimumOutputTokens = normaliseMinimumOutputTokens(parsed.minimumOutputTokens);
  const toolCallFormat = normaliseToolCallFormat(parsed.toolCallFormat);
  const modelToolCallFormats = normaliseModelToolCallFormats(parsed.modelToolCallFormats);
  const preambleVerbosity = normalisePreambleVerbosity(parsed.preambleVerbosity);
  const modelPreambleVerbosities = normaliseModelPreambleVerbosities(parsed.modelPreambleVerbosities);
  return {
    recordMessages: Boolean(parsed.recordMessages),
    scheduler: normaliseSchedulerSettings(parsed.scheduler),
    proxyPool: normaliseProxyPoolSettings(parsed.proxyPool),
    proxySync: normaliseProxySyncSettings(parsed.proxySync),
    ...(minimumOutputTokens !== undefined ? { minimumOutputTokens } : {}),
    ...(toolCallFormat ? { toolCallFormat } : {}),
    ...(modelToolCallFormats ? { modelToolCallFormats } : {}),
    ...(preambleVerbosity ? { preambleVerbosity } : {}),
    ...(modelPreambleVerbosities ? { modelPreambleVerbosities } : {}),
  };
}

function normaliseModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const model = item.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function normaliseStringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function normaliseAccountGroups(value: unknown): AccountGroup[] {
  if (!Array.isArray(value)) return [];
  const result: AccountGroup[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const group = raw as Record<string, unknown>;
    const id = typeof group.id === "string" ? group.id.trim() : "";
    const name = typeof group.name === "string" ? group.name.trim().slice(0, 120) : "";
    const foldedName = name.toLocaleLowerCase();
    if (!id || !name || ids.has(id) || names.has(foldedName)) continue;
    const createdAt = typeof group.createdAt === "string" ? group.createdAt : new Date(0).toISOString();
    result.push({
      id,
      name,
      enabled: group.enabled !== false,
      createdAt,
      updatedAt: typeof group.updatedAt === "string" ? group.updatedAt : createdAt,
      ...(typeof group.description === "string" && group.description.trim()
        ? { description: group.description.trim().slice(0, 500) }
        : {}),
    });
    ids.add(id);
    names.add(foldedName);
  }
  return result;
}

function normaliseGroupApiKeys(value: unknown, groupIds: ReadonlySet<string>): GroupApiKey[] {
  if (!Array.isArray(value)) return [];
  const result: GroupApiKey[] = [];
  const ids = new Set<string>();
  const namesByGroup = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const key = raw as Record<string, unknown>;
    const id = typeof key.id === "string" ? key.id.trim() : "";
    const groupId = typeof key.groupId === "string" ? key.groupId.trim() : "";
    const name = typeof key.name === "string" ? key.name.trim().slice(0, 120) : "";
    const prefix = typeof key.prefix === "string" ? key.prefix.trim().slice(0, 24) : "";
    const secretDigest = typeof key.secretDigest === "string" ? key.secretDigest.toLowerCase() : "";
    const nameKey = `${groupId}:${name.toLocaleLowerCase()}`;
    if (!id || !groupIds.has(groupId) || !name || !prefix || !/^[0-9a-f]{64}$/.test(secretDigest)
      || ids.has(id) || namesByGroup.has(nameKey)) continue;
    const createdAt = typeof key.createdAt === "string" ? key.createdAt : new Date(0).toISOString();
    result.push({
      id,
      groupId,
      name,
      prefix,
      secretDigest,
      enabled: key.enabled !== false,
      createdAt,
      updatedAt: typeof key.updatedAt === "string" ? key.updatedAt : createdAt,
    });
    ids.add(id);
    namesByGroup.add(nameKey);
  }
  return result;
}

function digestSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secretMatches(secret: string, digest: string): boolean {
  const candidate = Buffer.from(digestSecret(secret), "hex");
  const expected = Buffer.from(digest, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function createGroupSecret(): { secret: string; prefix: string; secretDigest: string } {
  const secret = `dig_${randomBytes(24).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 12), secretDigest: digestSecret(secret) };
}

function createUniqueGroupSecret(keys: readonly GroupApiKey[]): { secret: string; prefix: string; secretDigest: string } {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const material = createGroupSecret();
    if (!keys.some((key) => key.secretDigest === material.secretDigest)) return material;
  }
  throw new Error("Could not generate a unique group API key.");
}

function normaliseAccount(value: unknown): ManagedAccount {
  const account = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const id = typeof account.id === "string" && account.id ? account.id : randomUUID();
  const proxy = typeof account.proxy === "string" && account.proxy.trim() ? account.proxy.trim() : undefined;
  const models = normaliseModels(account.models);
  const schedulerOverrides = normaliseAccountSchedulerOverrides(account.schedulerOverrides, models);
  const proxyPoolEntryId = typeof account.proxyPoolEntryId === "string" && account.proxyPoolEntryId
    ? account.proxyPoolEntryId
    : undefined;
  const groupIds = normaliseStringIds(account.groupIds);
  const now = new Date().toISOString();
  return {
    id,
    label: typeof account.label === "string" && account.label.trim() ? account.label.trim() : "DeepInfra Free",
    weight: Math.max(1, Math.min(100, Math.floor(typeof account.weight === "number" ? account.weight : 1))),
    enabled: account.enabled !== false,
    groupIds,
    models,
    ...(proxy ? { egressStatus: account.egressStatus === "replacing" || account.egressStatus === "unavailable" ? account.egressStatus : "active" as const } : {}),
    ...(schedulerOverrides ? { schedulerOverrides } : {}),
    ...(proxy ? { proxy } : {}),
    ...(proxy && proxyPoolEntryId ? { proxyPoolEntryId } : {}),
    createdAt: typeof account.createdAt === "string" ? account.createdAt : now,
    updatedAt: typeof account.updatedAt === "string" ? account.updatedAt : now,
  };
}

function compareAt(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const PREVIEW_MAX_LENGTH = 60;
const NO_PREVIEW_TEXT = "（无消息内容）";

function previewContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return "";
      }
      const item = part as Record<string, unknown>;
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

/** Flatten chat messages or Responses input items into role/text pairs. */
function previewEntries(parsed: { messages?: unknown; input?: unknown }): { role: unknown; text: string }[] {
  if (Array.isArray(parsed.messages)) {
    return parsed.messages
      .map((message) => {
        const item = message && typeof message === "object" && !Array.isArray(message)
          ? message as Record<string, unknown>
          : {};
        return { role: item.role, text: previewContentText(item.content ?? item.text) };
      })
      .filter((item) => item.text);
  }
  if (typeof parsed.input === "string") {
    return parsed.input.trim() ? [{ role: "user", text: parsed.input }] : [];
  }
  if (Array.isArray(parsed.input)) {
    return parsed.input.flatMap((entry) => {
      const item = entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {};
      const type = typeof item.type === "string" ? item.type : typeof item.role === "string" ? "message" : "";
      if (type === "message") {
        const text = previewContentText(item.content);
        return text ? [{ role: item.role, text }] : [];
      }
      if (type === "function_call_output" || type === "custom_tool_call_output") {
        const output = item.output;
        const record = output && typeof output === "object" && !Array.isArray(output)
          ? output as Record<string, unknown>
          : undefined;
        const text = previewContentText(record ? record.content : output);
        return text ? [{ role: "tool", text }] : [];
      }
      return [];
    });
  }
  return [];
}

/** Short content preview: the last user message, else any last message. */
function recordPreview(record: DebugRecord): string {
  try {
    if (record.clientRequest.contentType !== "application/json") {
      return NO_PREVIEW_TEXT;
    }
    const parsed = JSON.parse(record.clientRequest.body) as { messages?: unknown; input?: unknown };
    const texts = previewEntries(parsed);
    const lastUser = [...texts].reverse().find((item) => item.role === "user");
    const source = lastUser ?? texts[texts.length - 1];
    const text = source ? source.text.replace(/\s+/g, " ").trim() : "";
    if (!text) {
      return NO_PREVIEW_TEXT;
    }
    return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…` : text;
  } catch {
    return NO_PREVIEW_TEXT;
  }
}

/** Model id from the client request body, when present. */
function recordModel(record: DebugRecord): string | undefined {
  try {
    if (record.clientRequest.contentType !== "application/json") {
      return undefined;
    }
    const parsed = JSON.parse(record.clientRequest.body) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/** True when the client request forces tool use via `tool_choice`. */
function recordForcesTool(record: DebugRecord): boolean {
  try {
    if (record.clientRequest.contentType !== "application/json") {
      return false;
    }
    const parsed = JSON.parse(record.clientRequest.body) as { tool_choice?: unknown };
    const choice = parsed.tool_choice;
    return choice === "required"
      || Boolean(choice && typeof choice === "object" && !Array.isArray(choice)
        && (choice as { type?: unknown }).type === "function");
  } catch {
    return false;
  }
}

/** Lightweight list metadata; bodies stay on disk until a record is opened. */
function summarizeRecord(record: DebugRecord): DebugRecordSummary {
  const legacy = record as { upstreamRequest?: unknown; upstreamResponse?: unknown };
  const summary: DebugRecordSummary = {
    id: record.id,
    at: record.at,
    endpoint: record.endpoint,
    status: record.status,
    preview: recordPreview(record),
    ...(recordModel(record) ? { model: recordModel(record) } : {}),
    ...(record.accountId ? { accountId: record.accountId } : {}),
    ...(record.accountLabel ? { accountLabel: record.accountLabel } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
  if (record.upstreamCalls?.length) {
    summary.upstreamCalls = record.upstreamCalls.map((call) => ({
      sequence: call.sequence,
      type: call.type,
      round: call.round,
      attempt: call.attempt,
      ...(call.accountId ? { accountId: call.accountId } : {}),
      ...(call.accountLabel ? { accountLabel: call.accountLabel } : {}),
      ...(call.responseStatus !== undefined ? { responseStatus: call.responseStatus } : {}),
      ...(call.error ? { error: call.error } : {}),
    }));
  } else if (legacy.upstreamRequest || legacy.upstreamResponse) {
    summary.legacyUpstream = true;
  }
  if (record.toolCallAdapter) {
    summary.toolCall = {
      forces: recordForcesTool(record),
      initialOutcome: record.toolCallAdapter.initialOutcome,
      finalOutcome: record.toolCallAdapter.finalOutcome,
    };
  }
  return summary;
}

export class StateStore {
  private state: PersistentState | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private recordIndexInit: Promise<RecordIndexEntry[]> | undefined;

  /** Clear cached state so tests can point the singleton at a fresh data dir. */
  resetForTests(): void {
    this.state = undefined;
    this.recordIndexInit = undefined;
  }

  private get storePath(): string {
    return join(getProxyConfig().dataDir, STORE_FILE);
  }

  private get recordsDir(): string {
    return join(getProxyConfig().dataDir, RECORDS_DIR);
  }

  private recordPath(id: string): string {
    return join(this.recordsDir, `${id}.json`);
  }

  async getState(): Promise<PersistentState> {
    if (this.state) {
      return this.state;
    }

    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: number; settings?: unknown; accounts?: unknown[]; proxyPool?: unknown; accountGroups?: unknown; groupApiKeys?: unknown; proxySyncRuns?: unknown };
      if ((parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) || !Array.isArray(parsed.accounts)) {
        throw new Error("The account store has an unsupported schema.");
      }

      const proxyPool = normaliseProxyPool(parsed.proxyPool);
      const accountGroups = normaliseAccountGroups(parsed.accountGroups);
      const validGroupIds = new Set(accountGroups.map((group) => group.id));
      const groupApiKeys = normaliseGroupApiKeys(parsed.groupApiKeys, validGroupIds);
      const poolById = new Map(proxyPool.map((entry) => [entry.id, entry]));
      // Legacy stores may contain NeuralWatt credentials. Only explicitly marked
      // DeepInfra accounts survive the v3 migration; ids and egress bindings remain.
      const migratedAccounts = parsed.version === 3 || parsed.version === 4
        ? parsed.accounts
        : parsed.accounts.filter((value) => Boolean(value)
          && typeof value === "object"
          && (value as Record<string, unknown>).provider === "deepinfra");
      const accounts = migratedAccounts.map(normaliseAccount).map((account) => {
        account.groupIds = account.groupIds.filter((groupId) => validGroupIds.has(groupId));
        const entry = account.proxyPoolEntryId ? poolById.get(account.proxyPoolEntryId) : undefined;
        if (entry && account.proxy === entry.url) return account;
        const { proxyPoolEntryId: _invalidPoolBinding, ...withoutBinding } = account;
        return withoutBinding;
      });
      const proxySyncRuns = normaliseProxySyncRuns(parsed.proxySyncRuns);
      this.state = {
        version: 4,
        settings: normaliseSettings(parsed.settings),
        accounts,
        proxyPool,
        accountGroups,
        groupApiKeys,
        proxySyncRuns,
      };
      if (parsed.version !== 4) {
        await this.writeState(this.state);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
      this.state = emptyState();
    }

    return this.state;
  }

  async listAccounts(): Promise<ManagedAccount[]> {
    return [...(await this.getState()).accounts];
  }

  async listAccountsPage(options: {
    page: number;
    pageSize: 20 | 50 | 100;
    query?: string;
    groupId?: string | null;
    status?: "all" | "enabled" | "disabled";
    sort?: "created_desc" | "created_asc" | "label_asc" | "label_desc";
  }): Promise<{ accounts: ManagedAccount[]; page: number; pageSize: 20 | 50 | 100; total: number; pageCount: number }> {
    const query = options.query?.trim().toLocaleLowerCase() ?? "";
    const status = options.status ?? "all";
    const sort = options.sort ?? "created_desc";
    let accounts = (await this.getState()).accounts.filter((account) => {
      if (status === "enabled" && !account.enabled) return false;
      if (status === "disabled" && account.enabled) return false;
      if (options.groupId === null && account.groupIds.length > 0) return false;
      if (typeof options.groupId === "string" && !account.groupIds.includes(options.groupId)) return false;
      return !query || account.label.toLocaleLowerCase().includes(query)
        || (account.proxy ?? "").toLocaleLowerCase().includes(query);
    });
    accounts = [...accounts].sort((left, right) => {
      if (sort === "label_asc" || sort === "label_desc") {
        const order = left.label.localeCompare(right.label, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id);
        return sort === "label_desc" ? -order : order;
      }
      const order = left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
      return sort === "created_desc" ? -order : order;
    });
    const total = accounts.length;
    const pageCount = Math.max(1, Math.ceil(total / options.pageSize));
    const page = Math.min(options.page, pageCount);
    const start = (page - 1) * options.pageSize;
    return { accounts: structuredClone(accounts.slice(start, start + options.pageSize)), page, pageSize: options.pageSize, total, pageCount };
  }

  async getAccount(id: string): Promise<ManagedAccount | undefined> {
    return (await this.getState()).accounts.find((account) => account.id === id);
  }

  async addAccount(input: {
    label?: string;
    weight?: number;
    proxy?: string;
    models?: string[];
    groupIds?: string[];
  }): Promise<ManagedAccount> {
    const requestedGroupIds = normaliseStringIds(input.groupIds);
    return this.mutate((state) => {
      const validGroupIds = new Set(state.accountGroups.map((group) => group.id));
      const unknownGroupId = requestedGroupIds.find((groupId) => !validGroupIds.has(groupId));
      if (unknownGroupId) throw new Error(`Account group not found: ${unknownGroupId}`);

      const now = new Date().toISOString();
      const account = normaliseAccount({
        id: randomUUID(),
        label: input.label?.trim() || "DeepInfra Free",
        enabled: true,
        weight: input.weight ?? 1,
        models: input.models ?? [],
        groupIds: requestedGroupIds,
        ...(input.proxy ? { proxy: input.proxy } : {}),
        createdAt: now,
        updatedAt: now,
      });
      assertUniqueAccountEgress(state.accounts, account);
      state.accounts.push(account);
      return account;
    });
  }

  async updateAccount(
    id: string,
    input: Partial<Pick<ManagedAccount, "label" | "enabled" | "weight"> & {
      proxy: string | null;
      models: string[];
      schedulerOverrides: AccountSchedulerOverrides | null;
      groupIds: string[];
    }>,
  ): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id);
      if (!account) {
        throw new Error("Account not found.");
      }

      if (typeof input.label === "string") {
        account.label = input.label.trim() || "DeepInfra Free";
      }
      if (typeof input.enabled === "boolean") {
        account.enabled = input.enabled;
      }
      if (typeof input.weight === "number") {
        account.weight = Math.max(1, Math.min(100, Math.floor(input.weight)));
      }
      if (typeof input.proxy === "string") {
        account.proxy = input.proxy;
        delete account.proxyPoolEntryId;
      } else if (input.proxy === null) {
        delete account.proxy;
        delete account.proxyPoolEntryId;
      }
      if (Array.isArray(input.groupIds)) {
        const groupIds = normaliseStringIds(input.groupIds);
        const validGroupIds = new Set(state.accountGroups.map((group) => group.id));
        const unknownGroupId = groupIds.find((groupId) => !validGroupIds.has(groupId));
        if (unknownGroupId) throw new Error(`Account group not found: ${unknownGroupId}`);
        account.groupIds = groupIds;
      }
      if (Array.isArray(input.models)) {
        account.models = normaliseModels(input.models);
      }
      if (input.schedulerOverrides === null) {
        delete account.schedulerOverrides;
      } else if (input.schedulerOverrides !== undefined) {
        account.schedulerOverrides = normaliseAccountSchedulerOverrides(input.schedulerOverrides, account.models);
      }
      account.schedulerOverrides = normaliseAccountSchedulerOverrides(account.schedulerOverrides, account.models);
      assertUniqueAccountEgress(state.accounts, account, id);
      account.updatedAt = new Date().toISOString();
      return account;
    });
  }

  async deleteAccount(id: string): Promise<void> {
    await this.mutate((state) => {
      const index = state.accounts.findIndex((account) => account.id === id);
      if (index === -1) {
        throw new Error("Account not found.");
      }
      state.accounts.splice(index, 1);
    });
  }

  /** Replace an account's model list with the current authoritative anonymous catalog. */
  async replaceAccountModels(id: string, models: string[]): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id);
      if (!account) {
        throw new Error("Account not found.");
      }
      account.models = normaliseModels(models);
      account.updatedAt = new Date().toISOString();
      return account;
    });
  }

  async listAccountGroups(): Promise<Array<AccountGroup & { accountCount: number; apiKeyCount: number }>> {
    const state = await this.getState();
    return state.accountGroups.map((group) => ({
      ...structuredClone(group),
      accountCount: state.accounts.filter((account) => account.groupIds.includes(group.id)).length,
      apiKeyCount: state.groupApiKeys.filter((key) => key.groupId === group.id).length,
    }));
  }

  async getAccountGroup(id: string): Promise<AccountGroup | undefined> {
    const group = (await this.getState()).accountGroups.find((candidate) => candidate.id === id);
    return group ? structuredClone(group) : undefined;
  }

  async createAccountGroup(input: { name: string; description?: string }): Promise<AccountGroup> {
    return this.mutate((state) => {
      const name = input.name.trim();
      if (!name) throw new Error("Account group name is required.");
      if (state.accountGroups.some((group) => group.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
        throw new Error("An account group with this name already exists.");
      }
      const now = new Date().toISOString();
      const group: AccountGroup = {
        id: randomUUID(), name, enabled: true, createdAt: now, updatedAt: now,
        ...(input.description?.trim() ? { description: input.description.trim().slice(0, 500) } : {}),
      };
      state.accountGroups.push(group);
      return structuredClone(group);
    });
  }

  async updateAccountGroup(id: string, input: { name?: string; description?: string | null; enabled?: boolean }): Promise<AccountGroup> {
    return this.mutate((state) => {
      const group = state.accountGroups.find((candidate) => candidate.id === id);
      if (!group) throw new Error("Account group not found.");
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new Error("Account group name is required.");
        if (state.accountGroups.some((candidate) => candidate.id !== id && candidate.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
          throw new Error("An account group with this name already exists.");
        }
        group.name = name;
      }
      if (input.description === null || input.description === "") delete group.description;
      else if (typeof input.description === "string") group.description = input.description.trim().slice(0, 500);
      if (typeof input.enabled === "boolean") group.enabled = input.enabled;
      group.updatedAt = new Date().toISOString();
      return structuredClone(group);
    });
  }

  async deleteAccountGroup(id: string): Promise<{ accountCount: number; apiKeyCount: number }> {
    return this.mutate((state) => {
      const index = state.accountGroups.findIndex((group) => group.id === id);
      if (index < 0) throw new Error("Account group not found.");
      const accountCount = state.accounts.filter((account) => account.groupIds.includes(id)).length;
      const apiKeyCount = state.groupApiKeys.filter((key) => key.groupId === id).length;
      for (const account of state.accounts) account.groupIds = account.groupIds.filter((groupId) => groupId !== id);
      state.groupApiKeys = state.groupApiKeys.filter((key) => key.groupId !== id);
      state.accountGroups.splice(index, 1);
      return { accountCount, apiKeyCount };
    });
  }

  async listGroupApiKeys(groupId: string): Promise<GroupApiKey[]> {
    return structuredClone((await this.getState()).groupApiKeys.filter((key) => key.groupId === groupId));
  }

  async createGroupApiKey(groupId: string, nameInput: string): Promise<{ key: GroupApiKey; secret: string }> {
    return this.mutate((state) => {
      if (!state.accountGroups.some((group) => group.id === groupId)) throw new Error("Account group not found.");
      const name = nameInput.trim();
      if (!name) throw new Error("API key name is required.");
      if (state.groupApiKeys.some((key) => key.groupId === groupId && key.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
        throw new Error("An API key with this name already exists in the group.");
      }
      const material = createUniqueGroupSecret(state.groupApiKeys);
      const now = new Date().toISOString();
      const key: GroupApiKey = { id: randomUUID(), groupId, name, prefix: material.prefix, secretDigest: material.secretDigest, enabled: true, createdAt: now, updatedAt: now };
      state.groupApiKeys.push(key);
      return { key: structuredClone(key), secret: material.secret };
    });
  }

  async rotateGroupApiKey(groupId: string, keyId: string): Promise<{ key: GroupApiKey; secret: string }> {
    return this.mutate((state) => {
      const key = state.groupApiKeys.find((candidate) => candidate.id === keyId && candidate.groupId === groupId);
      if (!key) throw new Error("Group API key not found.");
      const material = createUniqueGroupSecret(state.groupApiKeys);
      key.prefix = material.prefix;
      key.secretDigest = material.secretDigest;
      key.updatedAt = new Date().toISOString();
      return { key: structuredClone(key), secret: material.secret };
    });
  }

  async updateGroupApiKey(groupId: string, keyId: string, input: { name?: string; enabled?: boolean }): Promise<GroupApiKey> {
    return this.mutate((state) => {
      const key = state.groupApiKeys.find((candidate) => candidate.id === keyId && candidate.groupId === groupId);
      if (!key) throw new Error("Group API key not found.");
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new Error("API key name is required.");
        if (state.groupApiKeys.some((candidate) => candidate.id !== keyId && candidate.groupId === groupId && candidate.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0)) {
          throw new Error("An API key with this name already exists in the group.");
        }
        key.name = name;
      }
      if (typeof input.enabled === "boolean") key.enabled = input.enabled;
      key.updatedAt = new Date().toISOString();
      return structuredClone(key);
    });
  }

  async deleteGroupApiKey(groupId: string, keyId: string): Promise<void> {
    await this.mutate((state) => {
      const index = state.groupApiKeys.findIndex((key) => key.id === keyId && key.groupId === groupId);
      if (index < 0) throw new Error("Group API key not found.");
      state.groupApiKeys.splice(index, 1);
    });
  }

  async authenticateGroupApiKey(secret: string): Promise<{ key: GroupApiKey; group: AccountGroup } | undefined> {
    const state = await this.getState();
    for (const key of state.groupApiKeys) {
      if (!secretMatches(secret, key.secretDigest)) continue;
      const group = state.accountGroups.find((candidate) => candidate.id === key.groupId);
      return group ? { key: structuredClone(key), group: structuredClone(group) } : undefined;
    }
    return undefined;
  }

  async listProxyPool(): Promise<ProxyPoolEntry[]> {
    return structuredClone((await this.getState()).proxyPool);
  }

  async getProxyPoolEntry(id: string): Promise<ProxyPoolEntry | undefined> {
    const entry = (await this.getState()).proxyPool.find((candidate) => candidate.id === id);
    return entry ? structuredClone(entry) : undefined;
  }

  async importProxyPool(entries: Array<{ url: string; kind: ProxyKind; label?: string; source?: "manual" | "rola_free"; sourceMetadata?: ProxyPoolEntry["sourceMetadata"] }>): Promise<Array<{ entry: ProxyPoolEntry; created: boolean }>> {
    return this.mutate((state) => {
      const byUrl = new Map(state.proxyPool.map((entry) => [entry.url, entry]));
      const now = new Date().toISOString();
      return entries.map((input) => {
        const existing = byUrl.get(input.url);
        if (existing) {
          if (input.source === "rola_free") {
            existing.source = "rola_free";
            existing.updatedAt = now;
            if (input.sourceMetadata) existing.sourceMetadata = structuredClone(input.sourceMetadata);
          }
          return { entry: structuredClone(existing), created: false };
        }
        const entry: ProxyPoolEntry = {
          id: randomUUID(),
          url: input.url,
          kind: input.kind,
          source: input.source === "rola_free" ? "rola_free" : "manual",
          lifecycle: "active",
          failureCount: 0,
          createdAt: now,
          updatedAt: now,
          ...(input.sourceMetadata ? { sourceMetadata: structuredClone(input.sourceMetadata) } : {}),
          ...(input.label?.trim() ? { label: input.label.trim().slice(0, 120) } : {}),
        };
        state.proxyPool.push(entry);
        byUrl.set(entry.url, entry);
        return { entry: structuredClone(entry), created: true };
      });
    });
  }

  async updateProxyPoolHealth(
    id: string,
    health: { healthy: true; checkedAt: string } | { healthy: false; checkedAt: string; error: string; retryAfter: number },
  ): Promise<ProxyPoolEntry> {
    return this.mutate((state) => {
      const entry = state.proxyPool.find((candidate) => candidate.id === id);
      if (!entry) throw new Error("Proxy pool entry not found.");
      entry.lastCheckedAt = health.checkedAt;
      entry.updatedAt = health.checkedAt;
      if (health.healthy) {
        entry.lifecycle = "active";
        entry.failureCount = 0;
        entry.lastHealthyAt = health.checkedAt;
        delete entry.lastError;
        delete entry.failedAt;
        delete entry.archivedAt;
        delete entry.retryAfter;
      } else {
        entry.lifecycle = "failed";
        entry.failureCount += 1;
        entry.lastError = health.error.slice(0, 300);
        entry.failedAt = health.checkedAt;
        entry.retryAfter = health.retryAfter;
      }
      return structuredClone(entry);
    });
  }

  async createProxyAccountFromEntry(entryId: string, label?: string, models: string[] = []): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const entry = state.proxyPool.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error("Proxy pool entry not found.");
      if (entry.lifecycle === "archived") throw new Error("Archived proxies cannot create accounts.");
      const now = new Date().toISOString();
      const account = normaliseAccount({
        id: randomUUID(),
        label: label?.trim() || `Proxy ${entry.url}`,
        enabled: true,
        weight: 1,
        proxy: entry.url,
        proxyPoolEntryId: entry.id,
        egressStatus: "active",
        models,
        groupIds: [],
        createdAt: now,
        updatedAt: now,
      });
      assertUniqueAccountEgress(state.accounts, account);
      state.accounts.push(account);
      return structuredClone(account);
    });
  }

  async replaceAccountProxy(
    accountId: string,
    expectedProxy: string,
    replacementEntryId: string,
    failureReason: string,
  ): Promise<{ account: ManagedAccount; archived: ProxyPoolEntry; replacement: ProxyPoolEntry }> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error("Account not found.");
      if (!account.proxy || account.proxy !== expectedProxy) throw new Error("Account proxy changed before replacement completed.");
      const replacement = state.proxyPool.find((entry) => entry.id === replacementEntryId);
      if (!replacement) throw new Error("Replacement proxy not found.");
      if (replacement.lifecycle === "archived") throw new Error("Replacement proxy is archived.");
      const replacementEgress = egressIdentity(replacement.url).key;
      const duplicate = state.accounts.find((candidate) => candidate.id !== accountId && candidate.proxy && egressIdentity(candidate.proxy).key === replacementEgress);
      if (duplicate) throw new Error(`Egress is already assigned to account "${duplicate.label}"; one IP may serve only one account.`);
      const now = new Date().toISOString();
      let archived = account.proxyPoolEntryId ? state.proxyPool.find((entry) => entry.id === account.proxyPoolEntryId) : undefined;
      if (!archived) {
        const canonical = canonicalProxy(account.proxy);
        archived = {
          id: randomUUID(),
          url: canonical.url,
          kind: canonical.kind,
          source: "manual",
          lifecycle: "active",
          failureCount: 0,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        };
        state.proxyPool.push(archived);
      }
      archived.lifecycle = "archived";
      archived.failureCount = Math.max(archived.failureCount, 1);
      archived.lastError = failureReason.slice(0, 300);
      archived.failedAt ??= now;
      archived.archivedAt = now;
      archived.updatedAt = now;
      replacement.lifecycle = "active";
      replacement.failureCount = 0;
      replacement.updatedAt = now;
      delete replacement.lastError;
      delete replacement.failedAt;
      delete replacement.archivedAt;
      delete replacement.retryAfter;
      account.proxy = replacement.url;
      account.proxyPoolEntryId = replacement.id;
      account.egressStatus = "active";
      account.updatedAt = now;
      return { account: structuredClone(account), archived: structuredClone(archived), replacement: structuredClone(replacement) };
    });
  }

  async setAccountEgressStatus(accountId: string, status: "active" | "replacing" | "unavailable"): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error("Account not found.");
      if (!account.proxy) throw new Error("Direct accounts do not have managed egress status.");
      account.egressStatus = status;
      account.updatedAt = new Date().toISOString();
      return structuredClone(account);
    });
  }

  async archiveProxyPoolEntry(id: string, reason: string): Promise<ProxyPoolEntry> {
    return this.mutate((state) => {
      const entry = state.proxyPool.find((candidate) => candidate.id === id);
      if (!entry) throw new Error("Proxy pool entry not found.");
      const now = new Date().toISOString();
      entry.lifecycle = "archived";
      entry.lastError = reason.slice(0, 300);
      entry.failedAt ??= now;
      entry.archivedAt = now;
      entry.updatedAt = now;
      return structuredClone(entry);
    });
  }

  async pruneArchivedProxyPool(before: number): Promise<number> {
    return this.mutate((state) => {
      const boundIds = new Set(state.accounts.map((account) => account.proxyPoolEntryId).filter((id): id is string => Boolean(id)));
      const previous = state.proxyPool.length;
      state.proxyPool = state.proxyPool.filter((entry) => boundIds.has(entry.id) || entry.lifecycle !== "archived" || !entry.archivedAt || Date.parse(entry.archivedAt) >= before);
      return previous - state.proxyPool.length;
    });
  }

  async deleteProxyPoolEntry(id: string): Promise<void> {
    await this.mutate((state) => {
      if (state.accounts.some((account) => account.proxyPoolEntryId === id)) throw new Error("Proxy pool entry is assigned to an account.");
      const index = state.proxyPool.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error("Proxy pool entry not found.");
      state.proxyPool.splice(index, 1);
    });
  }

  async assignProxyPoolEntryFromProxy(accountId: string, entryId: string, expectedProxy: string): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error("Account not found.");
      if (account.proxy !== expectedProxy || account.proxyPoolEntryId) {
        throw new Error("Account proxy binding changed before assignment completed.");
      }
      const entry = state.proxyPool.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error("Proxy pool entry not found.");
      if (state.accounts.some((candidate) => candidate.id !== accountId && candidate.proxyPoolEntryId === entryId)) {
        throw new Error("Proxy pool entry is already assigned.");
      }
      account.proxy = entry.url;
      assertUniqueAccountEgress(state.accounts, account, accountId);
      account.proxyPoolEntryId = entry.id;
      account.egressStatus = "active";
      account.updatedAt = new Date().toISOString();
      return structuredClone(account);
    });
  }

  async clearCustomProxyIfMatches(accountId: string, expectedProxy: string): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error("Account not found.");
      if (account.proxy !== expectedProxy || account.proxyPoolEntryId) {
        throw new Error("Account proxy binding changed before direct fallback completed.");
      }
      delete account.proxy;
      account.updatedAt = new Date().toISOString();
      return structuredClone(account);
    });
  }

  async assignProxyPoolEntry(
    accountId: string,
    entryId: string,
    expectedCurrentEntryId: string | null,
  ): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error("Account not found.");
      if (expectedCurrentEntryId === null) {
        if (account.proxy || account.proxyPoolEntryId) throw new Error("Account already has a proxy.");
      } else if (account.proxyPoolEntryId !== expectedCurrentEntryId) {
        throw new Error("Account proxy binding changed before assignment completed.");
      }
      const entry = state.proxyPool.find((candidate) => candidate.id === entryId);
      if (!entry) throw new Error("Proxy pool entry not found.");
      if (state.accounts.some((candidate) => candidate.id !== accountId && candidate.proxyPoolEntryId === entryId)) {
        throw new Error("Proxy pool entry is already assigned.");
      }
      account.proxy = entry.url;
      assertUniqueAccountEgress(state.accounts, account, accountId);
      account.proxyPoolEntryId = entry.id;
      account.updatedAt = new Date().toISOString();
      return structuredClone(account);
    });
  }

  async bindProxyPoolEntry(accountId: string, entryId: string): Promise<ManagedAccount> {
    return this.assignProxyPoolEntry(accountId, entryId, null);
  }

  async unbindProxyPoolEntry(accountId: string, expectedEntryId?: string): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error("Account not found.");
      if (expectedEntryId && account.proxyPoolEntryId !== expectedEntryId) return structuredClone(account);
      const boundId = account.proxyPoolEntryId;
      const boundEntry = boundId ? state.proxyPool.find((entry) => entry.id === boundId) : undefined;
      if (boundEntry && account.proxy === boundEntry.url) delete account.proxy;
      delete account.proxyPoolEntryId;
      account.updatedAt = new Date().toISOString();
      return structuredClone(account);
    });
  }

  async getProxySyncSettings(): Promise<ProxySyncSettings> {
    return structuredClone((await this.getState()).settings.proxySync ?? DEFAULT_PROXY_SYNC_SETTINGS);
  }

  async updateProxySyncSettings(settings: Partial<ProxySyncSettings>): Promise<ProxySyncSettings> {
    return this.mutate((state) => {
      state.settings.proxySync = normaliseProxySyncSettings({ ...(state.settings.proxySync ?? DEFAULT_PROXY_SYNC_SETTINGS), ...settings });
      return structuredClone(state.settings.proxySync);
    });
  }

  async listProxySyncRuns(): Promise<ProxySyncRun[]> {
    return structuredClone((await this.getState()).proxySyncRuns).reverse();
  }

  async saveProxySyncRun(run: ProxySyncRun): Promise<void> {
    await this.mutate((state) => {
      state.proxySyncRuns = [...state.proxySyncRuns.filter((candidate) => candidate.id !== run.id), structuredClone(run)].slice(-100);
    });
  }

  async getSettings(): Promise<ProxySettings> {
    return { ...(await this.getState()).settings };
  }

  async updateSettings(settings: ProxySettingsUpdate): Promise<ProxySettings> {
    return this.mutate((state) => {
      if (typeof settings.recordMessages === "boolean") {
        state.settings.recordMessages = settings.recordMessages;
      }
      if (settings.scheduler !== undefined) {
        state.settings.scheduler = normaliseSchedulerSettings({ ...state.settings.scheduler, ...settings.scheduler });
      }
      if (settings.proxyPool !== undefined) {
        state.settings.proxyPool = normaliseProxyPoolSettings({ ...state.settings.proxyPool, ...settings.proxyPool });
      }
      if (settings.minimumOutputTokens !== undefined) {
        const minimumOutputTokens = normaliseMinimumOutputTokens(settings.minimumOutputTokens);
        if (minimumOutputTokens !== undefined) {
          state.settings.minimumOutputTokens = minimumOutputTokens;
        }
      }
      if (settings.toolCallFormat !== undefined) {
        const format = normaliseToolCallFormat(settings.toolCallFormat);
        if (format) {
          state.settings.toolCallFormat = format;
        } else {
          delete state.settings.toolCallFormat;
        }
      }
      if (settings.preambleVerbosity !== undefined) {
        const verbosity = normalisePreambleVerbosity(settings.preambleVerbosity);
        if (verbosity) {
          state.settings.preambleVerbosity = verbosity;
        } else {
          delete state.settings.preambleVerbosity;
        }
      }
      if (settings.modelToolCallFormats !== undefined) {
        const formats = normaliseModelToolCallFormats(settings.modelToolCallFormats);
        if (formats) {
          state.settings.modelToolCallFormats = formats;
        } else {
          delete state.settings.modelToolCallFormats;
        }
      }
      if (settings.modelPreambleVerbosities !== undefined) {
        const verbosities = normaliseModelPreambleVerbosities(settings.modelPreambleVerbosities);
        if (verbosities) {
          state.settings.modelPreambleVerbosities = verbosities;
        } else {
          delete state.settings.modelPreambleVerbosities;
        }
      }
      return { ...state.settings };
    });
  }

  async appendDebugRecord(record: DebugRecord): Promise<void> {
    if (!(await this.getSettings()).recordMessages) {
      return;
    }
    // Resolve the index before writing so a concurrent first-time build can
    // never observe this file on disk and then have it pushed a second time.
    const index = await this.getRecordIndex();
    const target = this.recordPath(record.id);
    await mkdir(this.recordsDir, { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    index.push({ summary: summarizeRecord(record), file: target });
    await this.pruneDebugRecords(index);
    await this.persistRecordIndex(index);
  }

  async listDebugRecords(limit = 100): Promise<DebugRecord[]> {
    const index = await this.getRecordIndex();
    const bounded = Math.max(1, Math.min(limit, MAX_DEBUG_RECORDS));
    const records = (await Promise.all(index.slice(-bounded).map((entry) => this.readRecordFile(entry.file))))
      .filter((record): record is DebugRecord => record !== undefined);
    records.sort((a, b) => compareAt(a.at, b.at));
    return records.reverse();
  }

  /**
   * List metadata for the newest records without touching record files. The
   * summaries are cached in the in-memory index, so this stays O(limit) no
   * matter how large the stored bodies are.
   */
  async listDebugRecordSummaries(limit = 100): Promise<DebugRecordSummary[]> {
    const index = await this.getRecordIndex();
    const bounded = Math.max(1, Math.min(limit, MAX_DEBUG_RECORDS));
    return index.slice(-bounded).map((entry) => entry.summary).reverse();
  }

  /** Read one full record (with bodies) on demand. */
  async getDebugRecord(id: string): Promise<DebugRecord | undefined> {
    const index = await this.getRecordIndex();
    const entry = index.find((candidate) => candidate.summary.id === id);
    return entry ? this.readRecordFile(entry.file) : undefined;
  }

  async deleteDebugRecordsForAccount(accountId: string): Promise<number> {
    const index = await this.getRecordIndex();
    const matches = new Set<string>();
    for (const entry of index) {
      if (entry.summary.accountId === accountId) {
        matches.add(entry.file);
      }
    }
    if (matches.size === 0) {
      return 0;
    }
    await Promise.all([...matches].map((file) => unlink(file).catch(() => undefined)));
    for (let position = index.length - 1; position >= 0; position -= 1) {
      const entry = index[position];
      if (entry && matches.has(entry.file)) {
        index.splice(position, 1);
      }
    }
    await this.persistRecordIndex(index);
    return matches.size;
  }

  async deleteAllDebugRecords(): Promise<number> {
    const index = await this.getRecordIndex();
    const files = await this.listRecordFiles();
    await Promise.all(files.map((file) => unlink(file).catch(() => undefined)));
    index.length = 0;
    await this.persistRecordIndex(index);
    return files.length;
  }

  private async listRecordFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.recordsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => join(this.recordsDir, entry.name));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readRecordFile(file: string): Promise<DebugRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as DebugRecord;
      return typeof parsed.id === "string" && typeof parsed.at === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Record metadata is cached in insertion order so appends and pruning stay
   * O(1). The index is built from one directory scan on first use; records
   * added by other processes appear only after a restart.
   */
  private getRecordIndex(): Promise<RecordIndexEntry[]> {
    if (!this.recordIndexInit) {
      this.recordIndexInit = this.buildRecordIndex().catch((error) => {
        this.recordIndexInit = undefined;
        throw error;
      });
    }
    return this.recordIndexInit;
  }

  private get recordIndexPath(): string {
    return join(getProxyConfig().dataDir, RECORD_INDEX_FILE);
  }

  /**
   * Build the in-memory index. A persisted index is reused when it covers
   * exactly the files on disk (record files are write-once and named by id,
   * so a matching filename set means the summaries are still valid);
   * otherwise every record file is parsed once and the index is rewritten.
   */
  private async buildRecordIndex(): Promise<RecordIndexEntry[]> {
    const files = await this.listRecordFiles();
    const persisted = await this.readPersistedRecordIndex();
    if (persisted) {
      const onDisk = new Set(files.map((file) => basename(file)));
      if (persisted.length === onDisk.size && persisted.every((entry) => onDisk.has(basename(entry.file)))) {
        return persisted;
      }
    }
    const parsed = await Promise.all(files.map(async (file) => ({ file, record: await this.readRecordFile(file) })));
    const entries: RecordIndexEntry[] = [];
    for (const { file, record } of parsed) {
      if (record) {
        entries.push({ summary: summarizeRecord(record), file });
      }
    }
    entries.sort((a, b) => compareAt(a.summary.at, b.summary.at));
    await this.persistRecordIndex(entries);
    return entries;
  }

  private async readPersistedRecordIndex(): Promise<RecordIndexEntry[] | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.recordIndexPath, "utf8")) as {
        version?: number;
        entries?: Array<{ summary?: DebugRecordSummary; name?: string }>;
      };
      // Version 2: summaries gained the request `model` field, so indexes
      // written by older versions are rebuilt from the record files.
      if (parsed.version !== 2 || !Array.isArray(parsed.entries)) {
        return undefined;
      }
      const entries: RecordIndexEntry[] = [];
      for (const entry of parsed.entries) {
        if (typeof entry.name !== "string" || typeof entry.summary?.id !== "string" || typeof entry.summary.at !== "string") {
          return undefined;
        }
        entries.push({ summary: entry.summary, file: join(this.recordsDir, entry.name) });
      }
      entries.sort((a, b) => compareAt(a.summary.at, b.summary.at));
      return entries;
    } catch {
      return undefined;
    }
  }

  /** Persist the index so restarts skip re-parsing every record file. */
  private async persistRecordIndex(index: RecordIndexEntry[]): Promise<void> {
    try {
      const target = this.recordIndexPath;
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      const body = JSON.stringify({
        version: 2,
        entries: index.map((entry) => ({ summary: entry.summary, name: basename(entry.file) })),
      });
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } catch {
      // A missing persisted index only means the next boot re-parses files.
    }
  }

  private async pruneDebugRecords(index: RecordIndexEntry[]): Promise<void> {
    const excess = index.splice(0, Math.max(0, index.length - MAX_DEBUG_RECORDS));
    await Promise.all(excess.map((entry) => unlink(entry.file).catch(() => undefined)));
  }

  private async mutate<T>(operation: (state: PersistentState) => T): Promise<T> {
    let result: T | undefined;
    let failure: unknown;

    const work = this.mutationQueue.then(async () => {
      let snapshot: PersistentState | undefined;
      try {
        const state = await this.getState();
        snapshot = structuredClone(state);
        result = operation(state);
        await this.writeState(state);
      } catch (error) {
        if (snapshot) {
          this.state = snapshot;
        }
        failure = error;
      }
    });
    this.mutationQueue = work.catch(() => undefined);
    await work;

    if (failure) {
      throw failure;
    }
    return result as T;
  }

  private async writeState(state: PersistentState): Promise<void> {
    const target = this.storePath;
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
}

export const stateStore = new StateStore();
