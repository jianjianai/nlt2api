import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getProxyConfig } from "~/server/utils/config.ts";
import { canonicalProxy } from "~/server/utils/proxy.ts";
import { DEFAULT_PROXY_POOL_SETTINGS, DEFAULT_SCHEDULER_SETTINGS } from "~/server/utils/types.ts";
import type {
  AccountSchedulerOverrides,
  DebugRecord,
  DebugRecordSummary,
  ManagedAccount,
  PersistentState,
  PortalSession,
  ProxyKind,
  ProxyPoolEntry,
  ProxyPoolSettings,
  ProxySettings,
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
    version: 1,
    settings: {
      recordMessages: false,
      scheduler: { ...DEFAULT_SCHEDULER_SETTINGS },
      proxyPool: { ...DEFAULT_PROXY_POOL_SETTINGS },
    },
    accounts: [],
    proxyPool: [],
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
        createdAt,
        updatedAt,
        ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim().slice(0, 120) } : {}),
        ...(typeof entry.lastCheckedAt === "string" ? { lastCheckedAt: entry.lastCheckedAt } : {}),
        ...(typeof entry.lastHealthyAt === "string" ? { lastHealthyAt: entry.lastHealthyAt } : {}),
        ...(typeof entry.lastError === "string" && entry.lastError ? { lastError: entry.lastError.slice(0, 300) } : {}),
        ...(typeof entry.failedAt === "string" ? { failedAt: entry.failedAt } : {}),
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

function normaliseAccount(account: ManagedAccount): ManagedAccount {
  const proxy = typeof account.proxy === "string" && account.proxy.trim() ? account.proxy.trim() : undefined;
  const models = normaliseModels(account.models);
  const schedulerOverrides = normaliseAccountSchedulerOverrides(account.schedulerOverrides, models);
  const proxyPoolEntryId = typeof account.proxyPoolEntryId === "string" && account.proxyPoolEntryId
    ? account.proxyPoolEntryId
    : undefined;
  const { schedulerOverrides: _discardedOverrides, proxyPoolEntryId: _discardedPoolId, ...accountWithoutOverrides } = account;
  return {
    ...accountWithoutOverrides,
    label: account.label.trim() || account.email,
    email: account.email.trim().toLowerCase(),
    weight: Math.max(1, Math.min(100, Math.floor(account.weight || 1))),
    enabled: account.enabled !== false,
    models,
    ...(schedulerOverrides ? { schedulerOverrides } : {}),
    ...(proxy ? { proxy } : {}),
    ...(proxy && proxyPoolEntryId ? { proxyPoolEntryId } : {}),
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
      const parsed = JSON.parse(raw) as PersistentState;
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
        throw new Error("The account store has an unsupported schema.");
      }

      const proxyPool = normaliseProxyPool(parsed.proxyPool);
      const poolById = new Map(proxyPool.map((entry) => [entry.id, entry]));
      const accounts = parsed.accounts.map(normaliseAccount).map((account) => {
        const entry = account.proxyPoolEntryId ? poolById.get(account.proxyPoolEntryId) : undefined;
        if (entry && account.proxy === entry.url) return account;
        const { proxyPoolEntryId: _invalidPoolBinding, ...withoutBinding } = account;
        return withoutBinding;
      });
      this.state = {
        version: 1,
        settings: normaliseSettings(parsed.settings),
        accounts,
        proxyPool,
      };
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

  async getAccount(id: string): Promise<ManagedAccount | undefined> {
    return (await this.getState()).accounts.find((account) => account.id === id);
  }

  async addAccount(input: {
    email: string;
    password: string;
    label?: string;
    weight?: number;
    proxy?: string;
    models?: string[];
  }): Promise<ManagedAccount> {
    const email = input.email.trim().toLowerCase();
    if (!email || !input.password) {
      throw new Error("An email and password are required.");
    }

    return this.mutate((state) => {
      if (state.accounts.some((account) => account.email === email)) {
        throw new Error("An account with this email already exists.");
      }

      const now = new Date().toISOString();
      const account = normaliseAccount({
        id: randomUUID(),
        label: input.label?.trim() || email,
        email,
        password: input.password,
        enabled: true,
        weight: input.weight ?? 1,
        models: input.models ?? [],
        ...(input.proxy ? { proxy: input.proxy } : {}),
        createdAt: now,
        updatedAt: now,
      });
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
    }>,
  ): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id);
      if (!account) {
        throw new Error("Account not found.");
      }

      if (typeof input.label === "string") {
        account.label = input.label.trim() || account.email;
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
      if (Array.isArray(input.models)) {
        account.models = normaliseModels(input.models);
      }
      if (input.schedulerOverrides === null) {
        delete account.schedulerOverrides;
      } else if (input.schedulerOverrides !== undefined) {
        account.schedulerOverrides = normaliseAccountSchedulerOverrides(input.schedulerOverrides, account.models);
      }
      account.schedulerOverrides = normaliseAccountSchedulerOverrides(account.schedulerOverrides, account.models);
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

  /** Append model ids to an account's list, deduplicating in place. */
  async mergeAccountModels(id: string, models: string[]): Promise<ManagedAccount> {
    return this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id);
      if (!account) {
        throw new Error("Account not found.");
      }
      account.models = normaliseModels([...(account.models ?? []), ...models]);
      account.updatedAt = new Date().toISOString();
      return account;
    });
  }

  async updateSession(id: string, session: PortalSession | undefined): Promise<void> {
    await this.mutate((state) => {
      const account = state.accounts.find((candidate) => candidate.id === id);
      if (!account) {
        throw new Error("Account not found.");
      }
      account.session = session;
      account.updatedAt = new Date().toISOString();
    });
  }

  async listProxyPool(): Promise<ProxyPoolEntry[]> {
    return structuredClone((await this.getState()).proxyPool);
  }

  async getProxyPoolEntry(id: string): Promise<ProxyPoolEntry | undefined> {
    const entry = (await this.getState()).proxyPool.find((candidate) => candidate.id === id);
    return entry ? structuredClone(entry) : undefined;
  }

  async importProxyPool(entries: Array<{ url: string; kind: ProxyKind; label?: string }>): Promise<Array<{ entry: ProxyPoolEntry; created: boolean }>> {
    return this.mutate((state) => {
      const byUrl = new Map(state.proxyPool.map((entry) => [entry.url, entry]));
      const now = new Date().toISOString();
      return entries.map((input) => {
        const existing = byUrl.get(input.url);
        if (existing) return { entry: structuredClone(existing), created: false };
        const entry: ProxyPoolEntry = {
          id: randomUUID(),
          url: input.url,
          kind: input.kind,
          createdAt: now,
          updatedAt: now,
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
        entry.lastHealthyAt = health.checkedAt;
        delete entry.lastError;
        delete entry.failedAt;
        delete entry.retryAfter;
      } else {
        entry.lastError = health.error.slice(0, 300);
        entry.failedAt = health.checkedAt;
        entry.retryAfter = health.retryAfter;
      }
      return structuredClone(entry);
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
      account.proxyPoolEntryId = entry.id;
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
