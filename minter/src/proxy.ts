export type ProxyKind = "http" | "socks4" | "socks5";

export interface BrowserProxyTarget {
  /** Value for Chrome's --proxy-server; credentials are never embedded here. */
  server: string;
  username?: string;
  password?: string;
}

/**
 * Splits a leased proxy URL into what Chrome needs. Chrome rejects credentials
 * inside --proxy-server, so HTTP auth is answered over CDP instead; it has no
 * mechanism at all for SOCKS auth, so such a proxy cannot mint (the gateway
 * already filters those out, this is the local guard).
 */
export function browserProxyTarget(raw: string): BrowserProxyTarget | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const protocol = url.protocol.toLowerCase();
  const kind: ProxyKind | undefined = protocol === "http:" || protocol === "https:"
    ? "http"
    : protocol === "socks4:" || protocol === "socks4a:"
      ? "socks4"
      : protocol === "socks:" || protocol === "socks5:" || protocol === "socks5h:"
        ? "socks5"
        : undefined;
  if (!kind || !url.hostname) return undefined;

  const username = url.username ? decodeURIComponent(url.username) : "";
  const password = url.password ? decodeURIComponent(url.password) : "";
  if (kind !== "http" && username) return undefined;

  const port = url.port || (kind === "http" ? "80" : "1080");
  return {
    server: `${kind === "http" ? "http" : kind}://${url.hostname}:${port}`,
    ...(username ? { username } : {}),
    ...(username && password ? { password } : {}),
  };
}

/** Redacts credentials before a proxy URL reaches a log line or the gateway. */
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
 * Strips credentials out of free-form text. Failure messages may quote a full
 * proxy URL, and unlike maskProxyUrl this keeps the rest of the message intact.
 */
export function redactProxyUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, (_match, scheme: string, credentials: string) => {
    const username = credentials.split(":")[0] ?? "";
    return `${scheme}${username.slice(0, 2)}***@`;
  });
}
