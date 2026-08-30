import { createRequire } from "node:module";
import net from "node:net";

interface SocksClientFactory {
  createConnection(options: Record<string, unknown>): Promise<{ socket: net.Socket }>;
}

let socksClient: SocksClientFactory | undefined | null;
/**
 * SOCKS support is an optional dependency: HTTP proxies cover the mintable
 * pool, and a bare install should not drag the socks package in for them.
 * Load lazily and only fail the leases that actually need SOCKS.
 */
function loadSocksClient(): SocksClientFactory | undefined {
  if (socksClient !== undefined) return socksClient ?? undefined;
  try {
    socksClient = (createRequire(import.meta.url)("socks") as { SocksClient: SocksClientFactory }).SocksClient;
  } catch {
    socksClient = null;
  }
  return socksClient ?? undefined;
}

/**
 * Parses any leased proxy URL, including credentialed SOCKS. Unlike
 * browserProxyTarget (which is scoped to what Chrome can drive) this is for the
 * local forwarder, which can authenticate SOCKS itself: Chrome talks ONLY to
 * this loopback proxy without credentials, and the forwarder owns upstream auth.
 */
export interface UpstreamTarget {
  kind: "http" | "socks4" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseUpstreamTarget(raw: string): UpstreamTarget | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const protocol = url.protocol.toLowerCase();
  const kind: UpstreamTarget["kind"] | undefined = protocol === "http:" || protocol === "https:"
    ? "http"
    : protocol === "socks4:" || protocol === "socks4a:"
      ? "socks4"
      : protocol === "socks:" || protocol === "socks5:" || protocol === "socks5h:"
        ? "socks5"
        : undefined;
  if (!kind || !url.hostname) return undefined;
  const username = url.username ? decodeURIComponent(url.username) : "";
  const password = url.password ? decodeURIComponent(url.password) : "";
  const port = Number(url.port) || (kind === "http" ? 80 : 1080);
  return {
    kind,
    host: url.hostname,
    port,
    ...(username ? { username } : {}),
    ...(username ? { password } : {}),
  };
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function basicAuthHeader(target: UpstreamTarget): string | undefined {
  if (!target.username) return undefined;
  return `Basic ${Buffer.from(`${target.username}:${target.password ?? ""}`).toString("base64")}`;
}

function parseHostHeader(request: net.Socket | undefined, hostHeader: string | undefined, defaultPort: number): { host: string; port: number } | undefined {
  if (!hostHeader) return undefined;
  const value = hostHeader.trim();
  if (!value) return undefined;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return undefined;
    const host = value.slice(1, close);
    const rest = value.slice(close + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : defaultPort;
    if (!Number.isFinite(port) || port <= 0) return undefined;
    return { host, port };
  }
  const lastColon = value.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(value.slice(lastColon + 1))) {
    const port = Number(value.slice(lastColon + 1));
    if (port <= 0 || port > 65535) return undefined;
    return { host: value.slice(0, lastColon), port };
  }
  return { host: value, port: defaultPort };
}

function readHeaders(socket: net.Socket, limit = 64 * 1024): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end !== -1) {
        const rest = buffer.subarray(end + 4);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
        if (rest.length > 0) socket.unshift(rest);
        resolve(buffer.subarray(0, end));
        return;
      }
      if (buffer.length > limit) {
        socket.off("data", onData);
        resolve(undefined);
      }
    };
    const onError = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      resolve(undefined);
    };
    const onClose = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      resolve(undefined);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

/**
 * A tiny loopback-only forwarder. Chrome is launched with
 * `--proxy-server=http://127.0.0.1:<port>` and never changes it; switching the
 * leased proxy is a `setUpstream` call that reroutes NEW connections without
 * touching the browser process.
 */
export class LocalForwardProxy {
  private server: net.Server | undefined;
  private upstream: UpstreamTarget | undefined;
  private readonly sockets = new Set<net.Socket>();
  private boundPort: number | undefined;

  get port(): number | undefined {
    return this.boundPort;
  }

  get upstreamUrl(): string | undefined {
    const target = this.upstream;
    if (!target) return undefined;
    const scheme = target.kind === "http" ? "http" : target.kind;
    const auth = target.username ? `${encodeURIComponent(target.username)}:${encodeURIComponent(target.password ?? "")}@` : "";
    return `${scheme}://${auth}${target.host}:${target.port}`;
  }

  /** Reroutes new connections; established tunnels finish on the old upstream. */
  setUpstream(raw: string | undefined): boolean {
    if (raw === undefined) {
      this.upstream = undefined;
      return true;
    }
    const target = parseUpstreamTarget(raw);
    if (!target) return false;
    this.upstream = target;
    return true;
  }

  start(): Promise<number> {
    if (this.server) return Promise.resolve(this.boundPort as number);
    const server = net.createServer((socket) => void this.handleClient(socket));
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      // Pause after the first bind: a port remembered from an earlier run is
      // reused, so the browser's --proxy-server flag survives a restart.
      const port = this.boundPort ?? 0;
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Local forward proxy did not bind to a TCP port."));
          return;
        }
        this.server = server;
        this.boundPort = address.port;
        resolve(address.port);
      });
    });
  }

  /**
   * Closes the listener but keeps the bound port reserved for the next
   * `start()`. The browser process holding `--proxy-server` restarts at the
   * same time, so the loopback port it was launched with must stay identical.
   */
  async restart(): Promise<void> {
    await this.teardown(false);
  }

  async close(): Promise<void> {
    await this.teardown(true);
  }

  private async teardown(releasePort: boolean): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (releasePort) this.boundPort = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleClient(client: net.Socket): Promise<void> {
    client.on("error", () => undefined);
    const headerBlock = await readHeaders(client);
    if (!headerBlock) {
      client.destroy();
      return;
    }
    const head = headerBlock.toString("latin1");
    const lines = head.split("\r\n");
    const requestLine = lines[0] ?? "";
    const spaceA = requestLine.indexOf(" ");
    const spaceB = requestLine.indexOf(" ", spaceA + 1);
    if (spaceA === -1 || spaceB === -1) {
      client.destroy();
      return;
    }
    const method = requestLine.slice(0, spaceA).toUpperCase();
    const target = requestLine.slice(spaceA + 1, spaceB);

    const headers: Array<[string, string]> = [];
    let hostHeader: string | undefined;
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
      if (name.toLowerCase() === "host") hostHeader = value;
      headers.push([name, value]);
    }

    const upstream = this.upstream;
    if (!upstream) {
      // No lease bound yet: answer rather than hang so the page fails fast and
      // the mint surfaces as a proxy failure instead of a stall.
      client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    if (method === "CONNECT") {
      const authority = parseHostHeader(undefined, target, 443);
      if (!authority) {
        client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      await this.tunnelViaConnect(client, upstream, authority.host, authority.port);
      return;
    }

    // Plain (non-CONNECT) request: parse the absolute URI Chrome sends when a
    // proxy is configured, then forward a cleaned-up origin-form request.
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    await this.forwardPlain(client, upstream, method, url, headers);
  }

  /** CONNECT then splice; also used as the transport for plain HTTPS requests. */
  private async tunnelViaConnect(
    client: net.Socket,
    upstream: UpstreamTarget,
    host: string,
    port: number,
    afterConnect?: (upstreamSocket: net.Socket) => void,
  ): Promise<void> {
    const upstreamSocket = await this.openUpstreamSocket(upstream, host, port);
    if (!upstreamSocket) {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (afterConnect) {
      afterConnect(upstreamSocket);
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstreamSocket.pipe(client);
    client.pipe(upstreamSocket);
    upstreamSocket.on("error", () => client.destroy());
    client.on("error", () => upstreamSocket.destroy());
  }

  /**
   * Opens a socket to the final destination through the upstream. HTTP
   * upstreams take a CONNECT; SOCKS upstreams get a handshake here instead.
   */
  private async openUpstreamSocket(upstream: UpstreamTarget, host: string, port: number): Promise<net.Socket | undefined> {
    if (upstream.kind === "http") {
      const socket = await new Promise<net.Socket | undefined>((resolve) => {
        const conn = net.connect(upstream.port, upstream.host, () => resolve(conn));
        conn.once("error", () => resolve(undefined));
      });
      if (!socket) return undefined;
      const auth = basicAuthHeader(upstream);
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
        "\r\n",
      ];
      socket.write(lines.join("\r\n"));
      const response = await readHeaders(socket);
      if (!response) {
        socket.destroy();
        return undefined;
      }
      const statusLine = response.toString("latin1").split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1]);
      if (!Number.isFinite(status) || status < 200 || status >= 300) {
        socket.destroy();
        return undefined;
      }
      return socket;
    }
    const client = loadSocksClient();
    if (!client) return undefined;
    try {
      const { socket } = await client.createConnection({
        proxy: {
          host: upstream.host,
          port: upstream.port,
          type: upstream.kind === "socks4" ? 4 : 5,
          ...(upstream.username ? { userId: upstream.username, password: upstream.password ?? "" } : {}),
        },
        command: "connect",
        destination: { host, port },
      });
      return socket as net.Socket;
    } catch {
      return undefined;
    }
  }

  private async forwardPlain(
    client: net.Socket,
    upstream: UpstreamTarget,
    method: string,
    url: URL,
    headers: Array<[string, string]>,
  ): Promise<void> {
    const isHttps = url.protocol === "https:";
    const port = Number(url.port) || (isHttps ? 443 : 80);
    // HTTPS sites also reach us as CONNECT from Chrome, but an absolute-URI
    // form is possible: tunnel those, then let the TLS bytes flow untouched.
    if (isHttps) {
      // Give the client its tunnel and splice; the request line we parsed was
      // the (encrypted) payload's framing, not something we can rewrite.
      await this.tunnelViaConnect(client, upstream, url.hostname, port);
      return;
    }
    const upstreamSocket = await this.openUpstreamSocket(upstream, url.hostname, port);
    if (!upstreamSocket) {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const path = `${url.pathname}${url.search}`;
    const auth = upstream.kind === "http" ? basicAuthHeader(upstream) : undefined;
    const out = [
      `${method} ${path} HTTP/1.1`,
      ...headers.map(([name, value]) => `${name}: ${value}`),
      ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
      "Connection: close",
      "\r\n",
    ];
    upstreamSocket.write(out.join("\r\n"));
    client.pipe(upstreamSocket);
    upstreamSocket.pipe(client);
    upstreamSocket.on("error", () => client.destroy());
    client.on("error", () => upstreamSocket.destroy());
  }
}
