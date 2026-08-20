import { stateStore } from "~/server/utils/state-store.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
import {
  MAX_PORTAL_CHAT_ATTEMPTS,
  portalRetryDelayMs,
  retryablePortalError,
  retryablePortalStatus,
} from "~/server/utils/upstream-retry.ts";
import type { ManagedAccount, PortalSession } from "~/server/utils/types.ts";

const PORTAL_ORIGIN = "https://portal.neuralwatt.com";
const CHAT_URL = `${PORTAL_ORIGIN}/api/chat`;
const LOGIN_URL = `${PORTAL_ORIGIN}/auth/login`;
// `/api/usage` also responds for an anonymous portal trial. `/dashboard` is the
// authenticated surface and redirects to `/auth/login` when the session expires.
const SESSION_PROBE_URL = `${PORTAL_ORIGIN}/dashboard`;
const responseFinishes = new WeakMap<Response, () => void>();

export class PortalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PortalError";
  }
}

function cookieValues(headers: Headers): string[] {
  const customHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof customHeaders.getSetCookie === "function") {
    return customHeaders.getSetCookie();
  }

  const combined = headers.get("set-cookie");
  if (!combined) {
    return [];
  }

  return combined.split(/,(?=[^;]+?=)/g);
}

function sessionFromResponse(response: Response): PortalSession | undefined {
  const values = cookieValues(response.headers);
  const cookies: string[] = [];
  let expiresAt: number | null = null;

  for (const raw of values) {
    const parts = raw.split(";").map((part) => part.trim());
    const pair = parts[0];
    if (!pair || !pair.includes("=")) {
      continue;
    }
    if (pair.slice(0, pair.indexOf("=")).trim() !== "nw_session") {
      continue;
    }
    cookies.push(pair);

    for (const attribute of parts.slice(1)) {
      const [key, ...rest] = attribute.split("=");
      const value = rest.join("=");
      if (key.toLowerCase() === "max-age") {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
          expiresAt = Date.now() + Math.max(0, seconds) * 1_000;
        }
      }
      if (key.toLowerCase() === "expires") {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) {
          expiresAt = timestamp;
        }
      }
    }
  }

  if (cookies.length === 0) {
    return undefined;
  }

  return {
    cookie: cookies.join("; "),
    expiresAt,
    updatedAt: new Date().toISOString(),
  };
}

async function portalFetch(input: string, init: RequestInit, clientSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let clientAborted = false;
  const clearTimeoutTimer = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  };
  const armTimeout = () => {
    clearTimeoutTimer();
    timedOut = false;
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, getProxyConfig().upstreamTimeoutMs);
  };
  const abortForClient = () => {
    clientAborted = true;
    controller.abort();
  };
  if (clientSignal?.aborted) {
    abortForClient();
  } else {
    clientSignal?.addEventListener("abort", abortForClient, { once: true });
  }
  const finish = () => {
    clearTimeoutTimer();
    clientSignal?.removeEventListener("abort", abortForClient);
  };
  armTimeout();
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    clearTimeoutTimer();
    if (!response.body) {
      finish();
      return response;
    }

    const reader = response.body.getReader();
    let bodyFinished = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          // Treat the configured timeout as inactivity, not a total generation
          // deadline. Long reasoning streams remain valid while data arrives.
          armTimeout();
          const chunk = await reader.read();
          clearTimeoutTimer();
          if (chunk.done) {
            bodyFinished = true;
            finish();
            streamController.close();
            return;
          }
          if (chunk.value) streamController.enqueue(chunk.value);
        } catch (error) {
          bodyFinished = true;
          finish();
          if (clientAborted || clientSignal?.aborted) {
            streamController.error(clientAbortError());
          } else if (timedOut) {
            streamController.error(new PortalError("The NeuralWatt portal response timed out while waiting for data.", 504));
          } else {
            streamController.error(error);
          }
        }
      },
      async cancel(reason) {
        if (bodyFinished) return;
        bodyFinished = true;
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    responseFinishes.set(wrapped, finish);
    return wrapped;
  } catch (error) {
    finish();
    if (error instanceof Error && error.name === "AbortError") {
      if (clientAborted || clientSignal?.aborted) {
        throw new PortalError("The client disconnected before the portal response completed.", 499);
      }
      throw new PortalError("The NeuralWatt portal request timed out while waiting for response headers.", 504);
    }
    throw error;
  }
}

function finishPortalResponse(response: Response): void {
  responseFinishes.get(response)?.();
  responseFinishes.delete(response);
}

async function discardPortalResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response may already be closed by an upstream redirect or error.
  } finally {
    finishPortalResponse(response);
  }
}

async function readPortalText(response: Response): Promise<string> {
  const maxBytes = getProxyConfig().maxUpstreamBytes;
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await discardPortalResponse(response);
    throw new PortalError("The NeuralWatt portal response exceeded the adapter limit.", 502);
  }
  if (!response.body) {
    finishPortalResponse(response);
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new PortalError("The NeuralWatt portal response exceeded the adapter limit.", 502);
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    if (error instanceof PortalError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new PortalError("The NeuralWatt portal response timed out.", 504);
    }
    throw error;
  } finally {
    reader.releaseLock();
    finishPortalResponse(response);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export interface PortalJsonBody {
  raw: string;
  value?: unknown;
  valid: boolean;
}

export async function readPortalJsonBody(response: Response): Promise<PortalJsonBody> {
  const body = await readPortalText(response);
  try {
    return { raw: body, value: JSON.parse(body), valid: true };
  } catch {
    return { raw: body, valid: false };
  }
}

export async function readPortalJson(response: Response): Promise<unknown> {
  const body = await readPortalJsonBody(response);
  if (!body.valid) {
    throw new PortalError("The NeuralWatt portal returned invalid JSON.", 502);
  }
  return body.value;
}

function sessionIsFresh(session: PortalSession | undefined): session is PortalSession {
  return session !== undefined
    && session.cookie.length > 0
    && (session.expiresAt === null || session.expiresAt > Date.now() + 30_000);
}

function clientAbortError(): PortalError {
  return new PortalError("The client disconnected before the portal response completed.", 499);
}

/**
 * Wait for a shared login without allowing one cancelled request to cancel the
 * login for other requests using the same account.
 */
async function waitWithClientAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw clientAbortError();
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(clientAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(parsed, 86_400);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const seconds = (timestamp - Date.now()) / 1_000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86_400) : undefined;
}

async function responseMessage(response: Response): Promise<string> {
  const body = await readPortalText(response);
  if (!body) {
    return `Portal request failed with HTTP ${response.status}.`;
  }
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string }; detail?: string };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (typeof parsed.error?.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.detail === "string") {
      return parsed.detail;
    }
  } catch {
    // The login endpoint uses an HTML error page; avoid returning it verbatim.
  }
  return `Portal request failed with HTTP ${response.status}.`;
}

export interface PortalChatRetry {
  status: number;
  contentType: string;
  body: string;
  error?: string;
}

export type PortalChatSessionRetry = PortalChatRetry;

async function waitForChatRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw clientAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(clientAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class PortalClient {
  private loginLocks = new Map<string, Promise<PortalSession>>();

  async ensureSession(account: ManagedAccount, signal?: AbortSignal): Promise<PortalSession> {
    if (sessionIsFresh(account.session)) {
      if (signal?.aborted) throw clientAbortError();
      return account.session;
    }

    const existing = this.loginLocks.get(account.id);
    if (existing) {
      return waitWithClientAbort(existing, signal);
    }

    const login = this.login(account).finally(() => {
      this.loginLocks.delete(account.id);
    });
    this.loginLocks.set(account.id, login);
    return waitWithClientAbort(login, signal);
  }

  async refreshSession(account: ManagedAccount, signal?: AbortSignal): Promise<PortalSession> {
    if (signal?.aborted) throw clientAbortError();
    await waitWithClientAbort(stateStore.updateSession(account.id, undefined), signal);
    const refreshed = await waitWithClientAbort(stateStore.getAccount(account.id), signal);
    if (!refreshed) {
      throw new PortalError("The selected account was removed while refreshing its session.", 503);
    }
    return this.ensureSession(refreshed, signal);
  }

  async requestChat(
    account: ManagedAccount,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    onRetry?: (attempt: PortalChatRetry) => void,
  ): Promise<Response> {
    let session = await this.ensureSession(account, signal);
    let sessionRetried = false;

    for (let attempt = 1; attempt <= MAX_PORTAL_CHAT_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        if (signal?.aborted) {
          throw clientAbortError();
        }
        response = await this.sendChat(session, body, signal);
      } catch (error) {
        if (signal?.aborted || error instanceof PortalError && error.status === 499) {
          throw clientAbortError();
        }
        if (attempt >= MAX_PORTAL_CHAT_ATTEMPTS || !retryablePortalError(error)) {
          throw error;
        }
        onRetry?.({
          status: 0,
          contentType: "",
          body: "",
          error: error instanceof Error ? error.message : "Unknown portal transport error.",
        });
        await waitForChatRetry(portalRetryDelayMs(attempt), signal);
        continue;
      }

      if ((response.status === 401 || response.status === 403) && !sessionRetried) {
        let responseBody = "";
        try {
          responseBody = await readPortalText(response);
        } catch {
          // The session refresh remains useful even when the expired-session
          // response is malformed.
        }
        onRetry?.({
          status: response.status,
          contentType: response.headers.get("content-type")?.toLowerCase() ?? "",
          body: responseBody,
        });
        session = await this.refreshSession(account, signal);
        sessionRetried = true;
        continue;
      }

      if (retryablePortalStatus(response.status) && attempt < MAX_PORTAL_CHAT_ATTEMPTS) {
        let responseBody = "";
        try {
          responseBody = await readPortalText(response);
        } catch {
          // The next attempt should still proceed when the error body is invalid.
        }
        onRetry?.({
          status: response.status,
          contentType: response.headers.get("content-type")?.toLowerCase() ?? "",
          body: responseBody,
        });
        await waitForChatRetry(portalRetryDelayMs(attempt), signal);
        continue;
      }

      return response;
    }

    throw new PortalError("The NeuralWatt portal request exhausted its retry budget.", 502);
  }

  finishResponse(response: Response): void {
    finishPortalResponse(response);
  }

  async verifyAccount(account: ManagedAccount): Promise<void> {
    const session = await this.refreshSession(account);
    const response = await portalFetch(SESSION_PROBE_URL, {
      headers: this.portalHeaders(session),
      redirect: "manual",
    });
    if (response.status !== 200) {
      throw new PortalError(await responseMessage(response), response.status, retryAfterSeconds(response));
    }
    await discardPortalResponse(response);
  }

  async listModels(): Promise<Record<string, unknown>[]> {
    const response = await portalFetch(`${PORTAL_ORIGIN}/api/models`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    if (!response.ok) {
      throw new PortalError(await responseMessage(response), response.status, retryAfterSeconds(response));
    }
    const payload = await readPortalJson(response) as { models?: unknown };
    return Array.isArray(payload.models)
      ? payload.models.filter((model): model is Record<string, unknown> => Boolean(model) && typeof model === "object" && !Array.isArray(model))
      : [];
  }

  private async login(account: ManagedAccount): Promise<PortalSession> {
    const form = new URLSearchParams({ email: account.email, password: account.password });
    const response = await portalFetch(LOGIN_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: PORTAL_ORIGIN,
        Referer: LOGIN_URL,
      },
      body: form,
    });

    if (response.status !== 302 && response.status !== 303 && !response.ok) {
      throw new PortalError(await responseMessage(response), response.status, retryAfterSeconds(response));
    }

    const session = sessionFromResponse(response);
    if (!session) {
      await discardPortalResponse(response);
      throw new PortalError("Portal login completed without a session cookie.", 502);
    }
    await discardPortalResponse(response);

    const probe = await portalFetch(SESSION_PROBE_URL, {
      headers: this.portalHeaders(session),
      redirect: "manual",
    });
    if (probe.status !== 200) {
      throw new PortalError(await responseMessage(probe), probe.status, retryAfterSeconds(probe));
    }
    await discardPortalResponse(probe);

    await stateStore.updateSession(account.id, session);
    return session;
  }

  private sendChat(session: PortalSession, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return portalFetch(CHAT_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...this.portalHeaders(session),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, signal);
  }

  private portalHeaders(session: PortalSession): HeadersInit {
    return {
      Accept: "application/json, text/event-stream",
      Cookie: session.cookie,
      Origin: PORTAL_ORIGIN,
      Referer: `${PORTAL_ORIGIN}/playground`,
      "User-Agent": "neuralwatt-openai-compat/1.0",
    };
  }
}

export const portalClient = new PortalClient();
