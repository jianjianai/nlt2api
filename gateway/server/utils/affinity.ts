import { createHash } from "node:crypto";
import type { SettingsStore } from "~/server/utils/settings.ts";
import type { JsonObject, JsonValue } from "~/server/utils/types.ts";

/** Beyond this the map is trimmed oldest-first; it is a memory bound, not a policy. */
const MAX_ENTRIES = 20_000;

interface Entry {
  proxyId: string;
  at: number;
}

/**
 * Stable identifier for the conversation a request belongs to.
 *
 * OpenAI-compatible clients resend the whole history every turn, so the *head*
 * of the message list — the system messages plus the first user message — is
 * identical across all turns of one conversation while differing between
 * conversations. Keying on the head is therefore stable without asking the
 * client for a session id. The optional `user` field is mixed in when present so
 * two callers opening with the same words do not collide.
 */
export function conversationKey(request: JsonObject): string | undefined {
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const firstUser = messages.findIndex((message) => (
    Boolean(message) && typeof message === "object" && !Array.isArray(message)
      && (message as JsonObject).role === "user"
  ));
  const head = messages.slice(0, firstUser >= 0 ? firstUser + 1 : messages.length);
  const material: JsonValue = {
    ...(typeof request.user === "string" && request.user ? { user: request.user } : {}),
    head: head as JsonValue,
  };
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
