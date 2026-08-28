import { setTimeout as delay } from "node:timers/promises";
import type { MintFailureReason } from "./protocol.ts";

export class MintError extends Error {
  constructor(readonly reason: MintFailureReason, message?: string) {
    super(message ?? `Mint failed: ${reason}`);
    this.name = "MintError";
  }
}

interface PausedRequest {
  requestId: string;
  url: string;
  resourceType?: string;
}

interface AuthRequired {
  requestId: string;
}

export interface CdpHandlers {
  onPaused?: (request: PausedRequest) => void;
  onAuthRequired?: (event: AuthRequired) => void;
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const CALL_TIMEOUT_MS = 45_000;

/**
 * Minimal CDP client over the native WebSocket.
 *
 * The Runtime and Console domains are never enabled: doing so trips
 * Cloudflare's automation probe and fails the challenge with error 600010.
 * Issuing a bare `Runtime.evaluate` call without enabling the domain is fine.
 */
export class CdpSession {
  private readonly socket: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private handlers: CdpHandlers = {};
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.onmessage = (event: MessageEvent) => this.dispatch(String(event.data));
    this.socket.onclose = () => this.failAll(new MintError("cdp_socket", "The CDP socket closed."));
    this.socket.onerror = () => this.failAll(new MintError("cdp_socket", "The CDP socket errored."));
  }

  static async open(webSocketUrl: string): Promise<CdpSession> {
    let lastError: MintError = new MintError("cdp_socket", `Failed to open the CDP socket at ${redactWebSocketUrl(webSocketUrl)}.`);
    // The browser may have exposed the HTTP endpoint moments before it accepts
    // socket upgrades, so an immediate ECONNREFUSED is worth a short retry
    // instead of surfacing as a mint failure.
    for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt += 1) {
      try {
        return await CdpSession.openOnce(webSocketUrl);
      } catch (error) {
        if (error instanceof MintError) lastError = error;
        if (attempt < OPEN_ATTEMPTS) await delay(OPEN_RETRY_DELAY_MS * attempt);
      }
    }
    throw lastError;
  }

  private static async openOnce(webSocketUrl: string): Promise<CdpSession> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
      };
      const timer = setTimeout(() => {
        cleanup();
        try { socket.close(); } catch { /* not yet open */ }
        reject(new MintError("cdp_socket", `Timed out opening the CDP socket at ${redactWebSocketUrl(webSocketUrl)}.`));
      }, OPEN_TIMEOUT_MS);
      timer.unref?.();
      socket.onopen = () => { cleanup(); resolve(); };
      socket.onerror = () => {
        cleanup();
        reject(new MintError("cdp_socket", `Failed to open the CDP socket at ${redactWebSocketUrl(webSocketUrl)}.`));
      };
      // A refused connection may surface as close-without-open instead of an
      // error event; report the close code so the two are distinguishable.
      socket.onclose = (event: CloseEvent) => {
        cleanup();
        reject(new MintError(
          "cdp_socket",
          `The CDP socket at ${redactWebSocketUrl(webSocketUrl)} closed before opening (code ${event.code}).`,
        ));
      };
    });
    return new CdpSession(socket);
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private dispatch(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      error?: { message: string };
      result?: unknown;
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new MintError("cdp_error", message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "Fetch.requestPaused" && message.params && this.handlers.onPaused) {
      const request = message.params.request as { url?: string } | undefined;
      this.handlers.onPaused({
        requestId: String(message.params.requestId),
        url: request?.url ?? "",
        ...(typeof message.params.resourceType === "string" ? { resourceType: message.params.resourceType } : {}),
      });
      return;
    }
    if (message.method === "Fetch.authRequired" && message.params && this.handlers.onAuthRequired) {
      this.handlers.onAuthRequired({ requestId: String(message.params.requestId) });
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new MintError("cdp_socket", "The CDP socket is closed."));
    const id = ++this.seq;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MintError("cdp_timeout", `CDP call timed out: ${method}`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  /** Fire-and-forget, for paused-request callbacks where no reply is needed. */
  post(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    this.socket.send(JSON.stringify({ id: ++this.seq, method, params }));
  }

  /** Evaluates in the page's main world WITHOUT enabling the Runtime domain. */
  async evaluate<T>(expression: string, awaitPromise = false): Promise<T | undefined> {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    };
    if (result.exceptionDetails) {
      throw new MintError("challenge_error", result.exceptionDetails.text ?? "Page evaluation threw.");
    }
    return result.result?.value;
  }

  watch(handlers: CdpHandlers): void {
    this.handlers = handlers;
  }

  close(): void {
    this.closed = true;
    this.handlers = {};
    try {
      this.socket.close();
    } catch {
      // Already closing; nothing to recover.
    }
  }
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`);
  } catch (error) {
    throw new MintError("cdp_unreachable", `CDP endpoint is unreachable: ${String(error)}`);
  }
  if (!response.ok) throw new MintError("cdp_unreachable", `CDP list failed with ${response.status}.`);
  return await response.json() as CdpTarget[];
}

export async function findPageTarget(port: number): Promise<CdpTarget | undefined> {
  try {
    const targets = await listTargets(port);
    return targets.find((target) => target.type === "page");
  } catch {
    return undefined;
  }
}

const OPEN_ATTEMPTS = 3;
const OPEN_RETRY_DELAY_MS = 250;
const OPEN_TIMEOUT_MS = 10_000;

/** Debugger URLs carry no credentials, but strip any userinfo defensively. */
function redactWebSocketUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
