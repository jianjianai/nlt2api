import { stateStore } from "~/server/utils/state-store.ts";
import { getProxyConfig } from "~/server/utils/config.ts";
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

async function portalFetch(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getProxyConfig().upstreamTimeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.body) {
      clearTimeout(timeout);
    } else {
      let finished = false;
      responseFinishes.set(response, () => {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
        }
      });
    }
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      throw new PortalError("The NeuralWatt portal request timed out.", 504);
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

export async function readPortalJson(response: Response): Promise<unknown> {
  const body = await readPortalText(response);
  try {
    return JSON.parse(body);
  } catch {
    throw new PortalError("The NeuralWatt portal returned invalid JSON.", 502);
  }
}

function sessionIsFresh(session: PortalSession | undefined): session is PortalSession {
  return session !== undefined
    && session.cookie.length > 0
    && (session.expiresAt === null || session.expiresAt > Date.now() + 30_000);
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

export class PortalClient {
  private loginLocks = new Map<string, Promise<PortalSession>>();

  async ensureSession(account: ManagedAccount): Promise<PortalSession> {
    if (sessionIsFresh(account.session)) {
      return account.session;
    }

    const existing = this.loginLocks.get(account.id);
    if (existing) {
      return existing;
    }

    const login = this.login(account).finally(() => {
      this.loginLocks.delete(account.id);
    });
    this.loginLocks.set(account.id, login);
    return login;
  }

  async refreshSession(account: ManagedAccount): Promise<PortalSession> {
    await stateStore.updateSession(account.id, undefined);
    const refreshed = await stateStore.getAccount(account.id);
    if (!refreshed) {
      throw new PortalError("The selected account was removed while refreshing its session.", 503);
    }
    return this.ensureSession(refreshed);
  }

  async requestChat(account: ManagedAccount, body: Record<string, unknown>): Promise<Response> {
    let session = await this.ensureSession(account);
    let response = await this.sendChat(session, body);
    if (response.status !== 401 && response.status !== 403 && (response.status < 300 || response.status >= 400)) {
      return response;
    }

    await discardPortalResponse(response);
    session = await this.refreshSession(account);
    response = await this.sendChat(session, body);
    return response;
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

  private sendChat(session: PortalSession, body: Record<string, unknown>): Promise<Response> {
    return portalFetch(CHAT_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...this.portalHeaders(session),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
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
