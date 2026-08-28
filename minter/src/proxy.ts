export type ProxyKind = "http" | "socks4" | "socks5";

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
