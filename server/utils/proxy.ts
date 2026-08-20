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

export type ProxyKind = "http" | "socks4" | "socks5";

export interface ParsedProxy {
  url: URL;
  kind: ProxyKind;
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
export function normalizeProxyUrl(raw: string): string {
  return parseProxy(raw).url.toString();
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

const dispatcherCache = new Map<string, Dispatcher>();

/**
 * Return a shared dispatcher for a stored proxy URL. Stored values are
 * validated on write, so an invalid value here indicates store corruption and
 * is allowed to throw.
 */
export function proxyDispatcher(proxy: string): Dispatcher {
  const key = proxy.trim();
  const cached = dispatcherCache.get(key);
  if (cached) {
    return cached;
  }
  const dispatcher = createDispatcher(key);
  dispatcherCache.set(key, dispatcher);
  return dispatcher;
}
