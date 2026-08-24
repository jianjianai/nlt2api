import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getProxyConfig } from "~/server/utils/config.ts";
import type { StoredResponseState } from "~/server/utils/types.ts";

const RESPONSES_DIR = "responses";
const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_STATE_TTL_MS = 12 * 60 * 60 * 1_000;

interface ResponseIndexEntry {
  id: string;
  createdAt: string;
  file: string;
  bytes: number;
}

/**
 * File-backed store for Responses API `previous_response_id` chains. Each
 * entry holds the full normalized item list (request input plus output
 * items), so a chain lookup is a single read regardless of chain length.
 * Clients such as Codex use `store: false` and resend their history; this
 * store only serves clients that opt into server-side state.
 */
export class ResponseStore {
  private indexInit: Promise<ResponseIndexEntry[]> | undefined;

  private get responsesDir(): string {
    return join(getProxyConfig().dataDir, RESPONSES_DIR);
  }

  private responsePath(id: string): string {
    return join(this.responsesDir, `${id}.json`);
  }

  async get(id: string): Promise<StoredResponseState | undefined> {
    if (!/^resp_[A-Za-z0-9_-]{1,96}$/.test(id)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(await readFile(this.responsePath(id), "utf8")) as StoredResponseState;
      if (parsed.id !== id || !Array.isArray(parsed.items)) {
        return undefined;
      }
      if (!parsed.access) {
        parsed.access = { scope: "global" };
      }
      const createdAt = Date.parse(parsed.createdAt);
      if (Number.isFinite(createdAt) && Date.now() - createdAt > RESPONSE_STATE_TTL_MS) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  async save(state: StoredResponseState): Promise<void> {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, "utf8") > getProxyConfig().maxResponseHistoryBytes) {
      // A single chain link beyond the per-history cap can never be served
      // faithfully; skip persisting it instead of truncating items.
      return;
    }
    const index = await this.getIndex();
    const target = this.responsePath(state.id);
    await mkdir(this.responsesDir, { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    index.push({ id: state.id, createdAt: state.createdAt, file: target, bytes: Buffer.byteLength(serialized, "utf8") });
    await this.prune(index);
  }

  private getIndex(): Promise<ResponseIndexEntry[]> {
    if (!this.indexInit) {
      this.indexInit = this.buildIndex().catch((error) => {
        this.indexInit = undefined;
        throw error;
      });
    }
    return this.indexInit;
  }

  private async buildIndex(): Promise<ResponseIndexEntry[]> {
    let entries: ResponseIndexEntry[] = [];
    try {
      const files = await readdir(this.responsesDir, { withFileTypes: true });
      entries = (await Promise.all(files
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const file = join(this.responsesDir, entry.name);
          try {
            const parsed = JSON.parse(await readFile(file, "utf8")) as StoredResponseState;
            if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") {
              return undefined;
            }
            return { id: parsed.id, createdAt: parsed.createdAt, file, bytes: Buffer.byteLength(JSON.stringify(parsed), "utf8") };
          } catch {
            return undefined;
          }
        })))
        .filter((entry): entry is ResponseIndexEntry => entry !== undefined);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    entries.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
    return entries;
  }

  private async prune(index: ResponseIndexEntry[]): Promise<void> {
    const maxBytes = getProxyConfig().maxResponseStateBytes;
    let total = index.reduce((sum, entry) => sum + entry.bytes, 0);
    while (index.length > MAX_STORED_RESPONSES || total > maxBytes) {
      const oldest = index.shift();
      if (!oldest) {
        break;
      }
      total -= oldest.bytes;
      await unlink(oldest.file).catch(() => undefined);
    }
  }
}

export const responseStore = new ResponseStore();
