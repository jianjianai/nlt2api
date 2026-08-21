import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getProxyConfig } from "~/server/utils/config.ts";
import type {
  DebugRecord,
  DebugRecordSummary,
  ManagedAccount,
  PersistentState,
  PortalSession,
  ProxySettings,
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
    settings: { recordMessages: false },
    accounts: [],
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
  return {
    ...account,
    label: account.label.trim() || account.email,
    email: account.email.trim().toLowerCase(),
    weight: Math.max(1, Math.min(100, Math.floor(account.weight || 1))),
    enabled: account.enabled !== false,
    models: normaliseModels(account.models),
    ...(proxy ? { proxy } : {}),
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

/** Short content preview: the last user message, else any last message. */
function recordPreview(record: DebugRecord): string {
  try {
    if (record.clientRequest.contentType !== "application/json") {
      return NO_PREVIEW_TEXT;
    }
    const parsed = JSON.parse(record.clientRequest.body) as { messages?: unknown };
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const texts = messages
      .map((message) => {
        const item = message && typeof message === "object" && !Array.isArray(message)
          ? message as Record<string, unknown>
          : {};
        return { role: item.role, text: previewContentText(item.content ?? item.text) };
      })
      .filter((item) => item.text);
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

      this.state = {
        version: 1,
        settings: { recordMessages: Boolean(parsed.settings?.recordMessages) },
        accounts: parsed.accounts.map(normaliseAccount),
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

  async updateAccount(id: string, input: Partial<Pick<ManagedAccount, "label" | "enabled" | "weight"> & { proxy: string | null; models: string[] }>): Promise<ManagedAccount> {
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
      } else if (input.proxy === null) {
        delete account.proxy;
      }
      if (Array.isArray(input.models)) {
        account.models = normaliseModels(input.models);
      }
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

  async getSettings(): Promise<ProxySettings> {
    return { ...(await this.getState()).settings };
  }

  async updateSettings(settings: Partial<ProxySettings>): Promise<ProxySettings> {
    return this.mutate((state) => {
      if (typeof settings.recordMessages === "boolean") {
        state.settings.recordMessages = settings.recordMessages;
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
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
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
        version: 1,
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
