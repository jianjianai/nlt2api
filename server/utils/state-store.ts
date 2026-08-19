import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getProxyConfig } from "~/server/utils/config.ts";
import type {
  DebugRecord,
  ManagedAccount,
  PersistentState,
  PortalSession,
  ProxySettings,
  ResponseState,
} from "~/server/utils/types.ts";

const STORE_FILE = "accounts.json";
const RECORDS_DIR = "records";
const MAX_DEBUG_RECORDS = 500;

export class ResponseStateLimitError extends Error {
  constructor() {
    super("The Responses state exceeds the configured storage budget.");
    this.name = "ResponseStateLimitError";
  }
}

function emptyState(): PersistentState {
  return {
    version: 1,
    settings: { recordMessages: false },
    accounts: [],
    responses: [],
  };
}

function normaliseAccount(account: ManagedAccount): ManagedAccount {
  return {
    ...account,
    label: account.label.trim() || account.email,
    email: account.email.trim().toLowerCase(),
    weight: Math.max(1, Math.min(100, Math.floor(account.weight || 1))),
    enabled: account.enabled !== false,
  };
}

function boundResponseStates(responses: ResponseState[]): ResponseState[] {
  const maxBytes = getProxyConfig().maxResponseStateBytes;
  const retained: ResponseState[] = [];
  let totalBytes = 2;
  for (let index = responses.length - 1; index >= 0 && retained.length < 500; index -= 1) {
    const response = responses[index];
    if (!response) continue;
    const bytes = Buffer.byteLength(JSON.stringify(response), "utf8") + (retained.length > 0 ? 1 : 0);
    if (totalBytes + bytes > maxBytes) {
      break;
    }
    retained.unshift(response);
    totalBytes += bytes;
  }
  return retained;
}

function compareAt(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class StateStore {
  private state: PersistentState | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

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
        responses: boundResponseStates((parsed.responses ?? []).filter((response) => response.createdAt > Date.now() - 12 * 60 * 60 * 1_000)),
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
        createdAt: now,
        updatedAt: now,
      });
      state.accounts.push(account);
      return account;
    });
  }

  async updateAccount(id: string, input: Partial<Pick<ManagedAccount, "label" | "enabled" | "weight">>): Promise<ManagedAccount> {
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
      // A Responses chain is account-affine. Remove it in the same durable
      // mutation so a deleted account cannot be resurrected by its history.
      state.responses = (state.responses ?? []).filter((response) => response.accountId !== id);
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

  async saveResponseState(response: ResponseState): Promise<void> {
    await this.mutate((state) => {
      // A completion may finish while its account is being deleted. The
      // serialized mutation order makes this check atomic with the write:
      // if deletion wins, discard the stale chain instead of recreating it.
      if (!state.accounts.some((account) => account.id === response.accountId)) {
        return;
      }
      const cutoff = Date.now() - 12 * 60 * 60 * 1_000;
      const retained = (state.responses ?? []).filter((candidate) => candidate.createdAt > cutoff && candidate.id !== response.id);
      retained.push(response);
      const bounded = boundResponseStates(retained);
      if (!bounded.some((candidate) => candidate.id === response.id)) {
        throw new ResponseStateLimitError();
      }
      state.responses = bounded;
    });
  }

  async getResponseState(id: string): Promise<ResponseState | undefined> {
    const state = await this.getState();
    const response = (state.responses ?? []).find((candidate) => candidate.id === id);
    if (
      !response
      || response.createdAt < Date.now() - 12 * 60 * 60 * 1_000
      || !state.accounts.some((account) => account.id === response.accountId)
    ) {
      return undefined;
    }
    return response;
  }

  async appendDebugRecord(record: DebugRecord): Promise<void> {
    if (!(await this.getSettings()).recordMessages) {
      return;
    }
    const target = this.recordPath(record.id);
    await mkdir(this.recordsDir, { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    await this.pruneDebugRecords();
  }

  async listDebugRecords(limit = 100): Promise<DebugRecord[]> {
    const records = await this.readAllDebugRecords();
    return records
      .slice(-Math.max(1, Math.min(limit, MAX_DEBUG_RECORDS)))
      .reverse()
      .map((entry) => entry.record);
  }

  async deleteDebugRecordsForAccount(accountId: string): Promise<number> {
    const records = await this.readAllDebugRecords();
    const matches = records.filter((entry) => entry.record.accountId === accountId);
    await Promise.all(matches.map((entry) => unlink(entry.file).catch(() => undefined)));
    return matches.length;
  }

  async deleteAllDebugRecords(): Promise<number> {
    const files = await this.listRecordFiles();
    await Promise.all(files.map((file) => unlink(file).catch(() => undefined)));
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

  private async readAllDebugRecords(): Promise<Array<{ file: string; record: DebugRecord }>> {
    const files = await this.listRecordFiles();
    const records: Array<{ file: string; record: DebugRecord }> = [];
    for (const file of files) {
      const record = await this.readRecordFile(file);
      if (record) {
        records.push({ file, record });
      }
    }
    records.sort((a, b) => compareAt(a.record.at, b.record.at));
    return records;
  }

  private async pruneDebugRecords(): Promise<void> {
    const records = await this.readAllDebugRecords();
    const excess = records.slice(0, Math.max(0, records.length - MAX_DEBUG_RECORDS));
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
