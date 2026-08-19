import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getProxyConfig } from "~/server/utils/config.ts";
import type {
  DebugRecord,
  ManagedAccount,
  PersistentState,
  PortalSession,
  ProxySettings,
  ResponseState,
  JsonObject,
  JsonValue,
} from "~/server/utils/types.ts";

const STORE_FILE = "accounts.enc";
const ENCRYPTED_PREFIX = "nw1";
const MAX_DEBUG_STRING_BYTES = 64 * 1024;

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
    debugRecords: [],
  };
}

function encryptionKey(): Buffer {
  const secret = getProxyConfig().storeKey;
  if (!secret) {
    throw new Error("NEURALWATT_STORE_KEY is required before storing portal accounts.");
  }

  return createHash("sha256").update(secret).digest();
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTED_PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decrypt(value: string): string {
  const [prefix, ivValue, tagValue, encryptedValue] = value.split(".");
  if (prefix !== ENCRYPTED_PREFIX || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("The encrypted account store has an invalid format.");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
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

function boundJson(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= MAX_DEBUG_STRING_BYTES) {
      return value;
    }
    const prefix = Buffer.from(value, "utf8").subarray(0, MAX_DEBUG_STRING_BYTES).toString("utf8");
    return `${prefix}\n[truncated by debug record limit]`;
  }
  if (Array.isArray(value)) {
    return value.map(boundJson);
  }
  if (value && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = item === undefined ? null : boundJson(item);
    }
    return result;
  }
  return value;
}

function boundDebugRecord(record: DebugRecord, maxBytes: number): DebugRecord {
  const bounded: DebugRecord = {
    ...record,
    clientRequest: boundJson(record.clientRequest) as JsonObject,
    ...(record.upstreamRequest ? { upstreamRequest: boundJson(record.upstreamRequest) as JsonObject } : {}),
    ...(record.clientResponse ? { clientResponse: boundJson(record.clientResponse) as JsonObject } : {}),
    ...(record.upstreamResponse ? { upstreamResponse: boundJson(record.upstreamResponse) as JsonObject } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes) {
    return bounded;
  }
  return {
    ...record,
    clientRequest: { _truncated: "This record exceeded the configured storage limit." },
    ...(record.upstreamRequest ? { upstreamRequest: { _truncated: "This record exceeded the configured storage limit." } } : {}),
    ...(record.clientResponse ? { clientResponse: { _truncated: "This record exceeded the configured storage limit." } } : {}),
    ...(record.upstreamResponse ? { upstreamResponse: { _truncated: "This record exceeded the configured storage limit." } } : {}),
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

export class StateStore {
  private state: PersistentState | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  private get storePath(): string {
    return join(getProxyConfig().dataDir, STORE_FILE);
  }

  async getState(): Promise<PersistentState> {
    if (this.state) {
      return this.state;
    }

    try {
      const raw = await readFile(this.storePath, "utf8");
      const parsed = JSON.parse(decrypt(raw)) as PersistentState;
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
        throw new Error("The encrypted account store has an unsupported schema.");
      }

      this.state = {
        version: 1,
        settings: { recordMessages: Boolean(parsed.settings?.recordMessages) },
        accounts: parsed.accounts.map(normaliseAccount),
        responses: boundResponseStates((parsed.responses ?? []).filter((response) => response.createdAt > Date.now() - 12 * 60 * 60 * 1_000)),
        debugRecords: Array.isArray(parsed.debugRecords) ? parsed.debugRecords : [],
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
    if (!response || response.createdAt < Date.now() - 12 * 60 * 60 * 1_000) {
      return undefined;
    }
    return response;
  }

  async appendDebugRecord(record: DebugRecord): Promise<void> {
    await this.mutate((state) => {
      if (!state.settings.recordMessages) {
        return;
      }
      const maxBytes = getProxyConfig().maxRecordBytes;
      const records = [...(state.debugRecords ?? []), boundDebugRecord(record, maxBytes)].slice(-500);
      while (records.length > 1 && Buffer.byteLength(JSON.stringify(records), "utf8") > maxBytes) {
        records.shift();
      }
      state.debugRecords = records;
    });
  }

  async listDebugRecords(limit = 100): Promise<DebugRecord[]> {
    return [...((await this.getState()).debugRecords ?? [])]
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse();
  }

  async deleteDebugRecordsForAccount(accountId: string): Promise<number> {
    return this.mutate((state) => {
      const before = state.debugRecords ?? [];
      const after = before.filter((record) => record.accountId !== accountId);
      state.debugRecords = after;
      return before.length - after.length;
    });
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
    await writeFile(temporary, encrypt(JSON.stringify(state)), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
}

export const stateStore = new StateStore();
