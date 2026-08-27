import { createHash } from "node:crypto";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { JsonObject, JsonValue } from "~/server/utils/types.ts";

/** Beyond this the map is trimmed oldest-first; it is a memory bound, not a policy. */
const MAX_ENTRIES = 20_000;
/** Anything longer is a client bug or an attempt to bloat the map; ignore it. */
const MAX_SESSION_ID_LENGTH = 200;

/** Headers clients use to name a conversation, in order of preference. */
const SESSION_HEADERS = ["x-session-id", "x-conversation-id", "x-chat-id"];
/** Equivalent body fields, for clients that cannot set headers. */
const SESSION_FIELDS = ["session_id", "conversation_id", "chat_id"];

interface Entry {
  proxyId: string;
  at: number;
}

function usableId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_SESSION_ID_LENGTH ? trimmed : undefined;
}

/** Reads an explicit conversation id from the request headers, if the client sent one. */
export function sessionIdFromHeaders(headers: Headers): string | undefined {
  for (const name of SESSION_HEADERS) {
    const value = usableId(headers.get(name));
    if (value) return value;
  }
  return undefined;
}

function sessionIdFromBody(request: JsonObject): string | undefined {
  for (const field of SESSION_FIELDS) {
    const value = usableId(request[field]);
    if (value) return value;
  }
  const metadata = request.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    for (const field of SESSION_FIELDS) {
      const value = usableId((metadata as JsonObject)[field]);
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Stable identifier for the conversation a request belongs to.
 *
 * An explicit id from the client wins: it is exact, survives history trimming,
 * and keeps working when a client edits earlier turns. Absent one, the *head* of
 * the message list — the system messages plus the first user message — is used
 * instead, because OpenAI-compatible clients resend the whole history every turn,
 * so the head is identical across all turns of one conversation while differing
 * between conversations. Either way the `user` field is mixed in when present, so
 * two callers cannot share a pin by reusing an id or an opening line.
 */
export function conversationKey(request: JsonObject, sessionId?: string): string | undefined {
  const explicit = usableId(sessionId) ?? sessionIdFromBody(request);
  const user = usableId(request.user);
  let material: JsonValue;
  if (explicit) {
    material = { kind: "session", id: explicit, ...(user ? { user } : {}) };
  } else {
    const messages = request.messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const firstUser = messages.findIndex((message) => (
      Boolean(message) && typeof message === "object" && !Array.isArray(message)
        && (message as JsonObject).role === "user"
    ));
    const head = messages.slice(0, firstUser >= 0 ? firstUser + 1 : messages.length);
    material = { kind: "head", head: head as JsonValue, ...(user ? { user } : {}) };
  }
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

export interface SessionAffinityDependencies {
  settings: SettingsStore;
  now?: () => number;
}

/**
 * Remembers which egress IP a conversation was last served from.
 *
 * Upstream ties its anonymous rate limit to the egress IP, so spreading requests
 * across the pool is what avoids 429s — but moving mid-conversation changes the
 * apparent client, which the upstream treats with suspicion. This map reconciles
 * the two: rotation is the default for new conversations, stickiness applies to
 * continuations. It is advisory only; a caller that cannot honour the preference
 * simply takes whatever is available. In-memory by design, since the tickets it
 * would point at do not survive a restart either.
 */
export class SessionAffinity {
  private readonly settings: SettingsStore;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(dependencies: SessionAffinityDependencies) {
    this.settings = dependencies.settings;
    this.now = dependencies.now ?? Date.now;
  }

  /** The egress this conversation should prefer, or undefined for a free choice. */
  resolve(key: string | undefined): string | undefined {
    const ttlMs = this.ttlMs();
    if (!key || ttlMs === 0) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.proxyId;
  }

  remember(key: string | undefined, proxyId: string): void {
    if (!key || this.ttlMs() === 0) return;
    // Re-inserting moves the key to the end, which makes eviction least-recent.
    this.entries.delete(key);
    this.entries.set(key, { proxyId, at: this.now() });
    this.trim();
  }

  /** Drops the pin, e.g. after the egress was rate limited or failed. */
  forget(key: string | undefined): void {
    if (key) this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }

  private ttlMs(): number {
    return this.settings.get().affinityTtlSeconds * 1_000;
  }

  private trim(): void {
    const cutoff = this.now() - this.ttlMs();
    for (const [key, entry] of this.entries) {
      if (entry.at >= cutoff && this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(key);
    }
  }
}
