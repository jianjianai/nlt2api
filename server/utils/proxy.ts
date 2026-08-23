import { createHash } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { SocksClient } from "socks";
import { Agent, ProxyAgent } from "undici";
import type { buildConnector, Dispatcher } from "undici";
import { HttpError } from "~/server/utils/http.ts";

const MAX_PROXY_URL_LENGTH = 2_048;
const SOCKS_CONNECT_TIMEOUT_MS = 30_000;

const SUPPORTED_PROTOCOLS = new Map<string, "http" | "socks4" | "socks5">([
  ["http:", "http"],
  ["https:", "http"],
  ["socks:", "socks5"],
  ["socks4:", "socks4"],
  ["socks4a:", "socks4"],
  ["socks5:", "socks5"],
  ["socks5h:", "socks5"],
]);

export type { ProxyKind } from "~/server/utils/types.ts";
import type { ProxyKind } from "~/server/utils/types.ts";

export class ProxyTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProxyTransportError";
  }
}

export function asProxyTransportError(error: unknown, fallback = "Proxy transport failed."): ProxyTransportError {
  if (error instanceof ProxyTransportError) return error;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = code === "ENOTFOUND" || code === "EAI_AGAIN"
    ? "Proxy DNS resolution failed."
    : code === "ECONNREFUSED"
      ? "Proxy connection was refused."
      : code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT"
        ? "Proxy connection timed out."
        : code.startsWith("ERR_TLS")
          ? "Proxy TLS handshake failed."
          : fallback;
  return new ProxyTransportError(message, { cause: error });
}

export interface ParsedProxy {
  url: URL;
  kind: ProxyKind;
}

export interface EgressIdentity {
  /** Internal grouping key; contains no proxy credentials. */
  key: string;
  /** Stable identifier safe for authenticated runtime status. */
  id: string;
  direct: boolean;
}

function invalidProxy(message: string): HttpError {
  return new HttpError(400, message, "invalid_request_error", "proxy");
}

function parseProxy(raw: string): ParsedProxy {
  const value = raw.trim();
  if (!value) {
    throw invalidProxy("`proxy` must be a non-empty string.");
  }
  if (value.length > MAX_PROXY_URL_LENGTH) {
    throw invalidProxy("`proxy` is too long.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidProxy("`proxy` must be a valid URL, e.g. http://user:pass@host:8080 or socks5://host:1080.");
  }

  const kind = SUPPORTED_PROTOCOLS.get(url.protocol.toLowerCase());
  if (!kind) {
    throw invalidProxy("`proxy` protocol must be http, https, socks4 or socks5.");
  }
  if (!url.hostname) {
    throw invalidProxy("`proxy` must include a proxy host.");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw invalidProxy("`proxy` must not include a path, query or fragment.");
  }
  return { url, kind };
}

/**
 * Validate a user supplied proxy URL and return its canonical form for
 * storage. Throws an HttpError(400) when the URL is unusable.
 */
export function egressIdentity(raw?: string): EgressIdentity {
  if (!raw) {
    return { key: "direct", id: "egress_direct", direct: true };
  }
  const { url, kind } = parseProxy(raw);
  const defaultPort = kind === "http"
    ? url.protocol.toLowerCase() === "https:" ? 443 : 80
    : 1080;
  // Group transport aliases that reach the same proxy endpoint: socks,
  // socks5 and socks5h share one SOCKS5 bucket; socks4/socks4a share SOCKS4.
  const key = `${kind}://${url.hostname.toLowerCase()}:${url.port || defaultPort}`;
  const digest = createHash("sha256").update(key).digest("base64url").slice(0, 12);
  return { key, id: `egress_${digest}`, direct: false };
}

export interface CanonicalProxy {
  url: string;
  kind: ProxyKind;
}

export interface ProxyImportResult extends CanonicalProxy {
  source: string;
}

export function canonicalProxy(raw: string): CanonicalProxy {
  const parsed = parseProxy(raw);
  return { url: parsed.url.toString(), kind: parsed.kind };
}

function shorthandHostPort(value: string): { host: string; port: string; username?: string; password?: string } {
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\]:(\d+)(?::([^:]*):(.*))?$/.exec(value);
    if (!match) throw invalidProxy("Bracketed IPv6 proxies must use [host]:port or [host]:port:user:pass.");
    return { host: `[${match[1]}]`, port: match[2]!, ...(match[3] !== undefined ? { username: match[3], password: match[4] ?? "" } : {}) };
  }

  const hostFirst = /^([^:@]+):(\d+):([^:]*):(.*)$/.exec(value);
  if (hostFirst) {
    return {
      host: hostFirst[1]!,
      port: hostFirst[2]!,
      username: hostFirst[3]!,
      password: hostFirst[4]!,
    };
  }

  const at = value.lastIndexOf("@");
  if (at >= 0) {
    const credentials = value.slice(0, at);
    const endpoint = value.slice(at + 1);
    const separator = credentials.indexOf(":");
    if (separator <= 0) throw invalidProxy("Authenticated shorthand must use user:pass@host:port.");
    const endpointSeparator = endpoint.lastIndexOf(":");
    if (endpointSeparator <= 0) throw invalidProxy("Proxy shorthand must include host and port.");
    return {
      host: endpoint.slice(0, endpointSeparator),
      port: endpoint.slice(endpointSeparator + 1),
      username: credentials.slice(0, separator),
      password: credentials.slice(separator + 1),
    };
  }

  const parts = value.split(":");
  if (parts.length === 2) return { host: parts[0]!, port: parts[1]! };
  throw invalidProxy("Proxy shorthand must use host:port, host:port:user:pass or user:pass@host:port.");
}

export function parseProxyImportLine(raw: string, defaultProtocol: ProxyKind): ProxyImportResult {
  const source = raw.trim();
  if (!source) throw invalidProxy("Proxy line is empty.");
  if (source.length > MAX_PROXY_URL_LENGTH) throw invalidProxy("Proxy line is too long.");
  if (source.includes("://")) return { source, ...canonicalProxy(source) };

  const { host, port, username, password } = shorthandHostPort(source);
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw invalidProxy("Proxy port must be an integer from 1 through 65535.");
  }
  if (!host.trim()) throw invalidProxy("Proxy shorthand must include a host.");
  const auth = username !== undefined
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? "")}@`
    : "";
  return { source, ...canonicalProxy(`${defaultProtocol}://${auth}${host}:${numericPort}`) };
}

export function normalizeProxyUrl(raw: string): string {
  return canonicalProxy(raw).url;
}

/** Render a proxy URL for the admin panel without leaking credentials. */
export function maskProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const username = decodeURIComponent(url.username);
    const auth = username ? `${username.slice(0, 2)}***@` : "";
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${auth}${url.hostname}${port}`;
  } catch {
    return "***";
  }
}

/**
 * Build an undici connector that tunnels every connection through a SOCKS4/5
 * proxy. DNS names are forwarded to the proxy (socks4a / socks5h semantics).
 */
function socksConnector(proxy: URL, type: 4 | 5): buildConnector.connector {
  const proxyPort = Number(proxy.port) || 1080;
  const userId = proxy.username ? decodeURIComponent(proxy.username) : undefined;
  const password = proxy.password ? decodeURIComponent(proxy.password) : undefined;

  return (options, callback) => {
    const targetPort = Number(options.port) || (options.protocol === "https:" ? 443 : 80);
    SocksClient.createConnection({
      proxy: {
        host: proxy.hostname,
        port: proxyPort,
        type,
        ...(userId ? { userId } : {}),
        ...(password ? { password } : {}),
      },
      command: "connect",
      destination: {
        host: options.hostname,
        port: targetPort,
      },
      timeout: SOCKS_CONNECT_TIMEOUT_MS,
    }).then(({ socket }) => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 60_000);
      if (options.protocol !== "https:") {
        callback(null, socket);
        return;
      }
      const secure = tlsConnect({
        socket,
        servername: options.servername || options.hostname,
        ALPNProtocols: ["http/1.1"],
      });
      let settled = false;
      secure.once("secureConnect", () => {
        if (settled) return;
        settled = true;
        callback(null, secure);
      });
      secure.once("error", (error) => {
        if (settled) return;
        settled = true;
        callback(error, null);
      });
    }).catch((error) => {
      callback(error instanceof Error ? error : new Error(String(error)), null);
    });
  };
}

function createDispatcher(raw: string): Dispatcher {
  const { url, kind } = parseProxy(raw);
  if (kind === "http") {
    return new ProxyAgent(url.toString());
  }
  return new Agent({ connect: socksConnector(url, kind === "socks4" ? 4 : 5) });
}

const MAX_DISPATCHER_CACHE = 128;
const dispatcherCache = new Map<string, Dispatcher>();

function cacheDispatcher(key: string, dispatcher: Dispatcher): void {
  dispatcherCache.delete(key);
  dispatcherCache.set(key, dispatcher);
  while (dispatcherCache.size > MAX_DISPATCHER_CACHE) {
    const oldest = dispatcherCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = dispatcherCache.get(oldest);
    dispatcherCache.delete(oldest);
    if (evicted) void evicted.close().catch(() => undefined);
  }
}

export async function evictProxyDispatcher(proxy: string): Promise<void> {
  const key = proxy.trim();
  const dispatcher = dispatcherCache.get(key);
  if (!dispatcher) return;
  dispatcherCache.delete(key);
  await dispatcher.close().catch(() => undefined);
}

export function proxyDispatcherCacheSize(): number {
  return dispatcherCache.size;
}

export async function resetProxyDispatcherCacheForTests(): Promise<void> {
  const dispatchers = [...dispatcherCache.values()];
  dispatcherCache.clear();
  await Promise.all(dispatchers.map((dispatcher) => dispatcher.close().catch(() => undefined)));
}

/**
 * Return a shared dispatcher for a stored proxy URL. Stored values are
 * validated on write, so an invalid value here indicates store corruption and
 * is allowed to throw.
 */
export function proxyDispatcher(proxy: string): Dispatcher {
  const key = proxy.trim();
  const cached = dispatcherCache.get(key);
  if (cached) {
    dispatcherCache.delete(key);
    dispatcherCache.set(key, cached);
    return cached;
  }
  const dispatcher = createDispatcher(key);
  cacheDispatcher(key, dispatcher);
  return dispatcher;
}
