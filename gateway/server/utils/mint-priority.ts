/** Beyond this a priority entry is stale: whoever asked for it has long given up. */
const MAX_AGE_MS = 120_000;
/** A request path that keeps asking must not be able to make the list unbounded. */
const MAX_ENTRIES = 200;

export interface MintPriorityDependencies {
  now?: () => number;
}

/**
 * Egress IPs that a waiting request specifically needs a ticket for.
 *
 * Without this the refill loop only knows *how many* tickets are missing, not
 * *where*, so a request pinned to one egress would wait for the fair rotation to
 * reach it. Entries are advisory and short-lived: the lease path prefers them,
 * and a stale one costs at most one misplaced mint.
 */
export class MintPriority {
  private readonly now: () => number;
  private readonly entries = new Map<string, number>();

  constructor(dependencies: MintPriorityDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
  }

  request(proxyId: string): void {
    this.entries.delete(proxyId);
    this.entries.set(proxyId, this.now());
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Proxy ids to mint for first, oldest request first. */
  ids(): string[] {
    const cutoff = this.now() - MAX_AGE_MS;
    for (const [proxyId, at] of this.entries) {
      if (at < cutoff) this.entries.delete(proxyId);
      else break;
    }
    return [...this.entries.keys()];
  }

  clear(proxyId: string): void {
    this.entries.delete(proxyId);
  }

  size(): number {
    return this.ids().length;
  }
}
