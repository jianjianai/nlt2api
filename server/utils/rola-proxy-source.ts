import { isIP } from "node:net";
import { parseProxyImportLine } from "~/server/utils/proxy.ts";
import type { ProxyKind, ProxySourceMetadata } from "~/server/utils/types.ts";

export const ROLA_FREE_PROXY_URL = "https://rola-ip.co/zh/tools/free-proxy-list";

export interface RolaProxyCandidate {
  url: string;
  kind: ProxyKind;
  ip: string;
  port: number;
  protocol: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5";
  metadata: ProxySourceMetadata;
}

const HEADER_ALIASES = {
  ip: ["ip address", "ip地址", "ip"],
  port: ["端口", "port"],
  country: ["国家/地区", "country/region", "country"],
  protocol: ["协议", "protocol"],
  anonymity: ["匿名度", "anonymity"],
  latency: ["速度", "speed", "latency"],
  uptime: ["在线率", "uptime", "availability"],
  checked: ["最近检测", "last checked", "checked"],
} as const;

function decodeHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function cells(row: string, tag: "th" | "td"): string[] {
  return [...row.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))]
    .map((match) => decodeHtml(match[1] ?? ""));
}

function normalizeHeader(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, "").replace(/[：:]/g, "");
}

function column(headers: string[], aliases: readonly string[]): number {
  const normalizedAliases = aliases.map(normalizeHeader);
  return headers.findIndex((header) => normalizedAliases.includes(normalizeHeader(header)));
}

function publicIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function numberFrom(value: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?/.exec(value.replaceAll(",", ""));
  if (!match) return undefined;
  const result = Number(match[0]);
  return Number.isFinite(result) ? result : undefined;
}

function protocol(value: string): RolaProxyCandidate["protocol"] | undefined {
  const normalized = value.trim().toUpperCase();
  return normalized === "HTTP" || normalized === "HTTPS" || normalized === "SOCKS4" || normalized === "SOCKS5"
    ? normalized
    : undefined;
}

function proxyKind(value: RolaProxyCandidate["protocol"]): ProxyKind {
  return value === "SOCKS4" ? "socks4" : value === "SOCKS5" ? "socks5" : "http";
}

export function parseRolaProxyHtml(html: string, sourceUrl = ROLA_FREE_PROXY_URL): RolaProxyCandidate[] {
  const table = /<table\b[^>]*class="[^"]*fpl-proxy[^"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1]
    ?? /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) throw new Error("Rola proxy table was not found.");
  const headerRow = /<thead\b[^>]*>[\s\S]*?<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(table)?.[1];
  if (!headerRow) throw new Error("Rola proxy table headers were not found.");
  const headers = cells(headerRow, "th");
  const indexes = {
    ip: column(headers, HEADER_ALIASES.ip),
    port: column(headers, HEADER_ALIASES.port),
    country: column(headers, HEADER_ALIASES.country),
    protocol: column(headers, HEADER_ALIASES.protocol),
    anonymity: column(headers, HEADER_ALIASES.anonymity),
    latency: column(headers, HEADER_ALIASES.latency),
    uptime: column(headers, HEADER_ALIASES.uptime),
    checked: column(headers, HEADER_ALIASES.checked),
  };
  if (indexes.ip < 0 || indexes.port < 0 || indexes.protocol < 0) {
    throw new Error("Rola proxy table is missing IP, port or protocol columns.");
  }
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(table)?.[1] ?? table;
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => cells(match[1] ?? "", "td"));
  const seen = new Set<string>();
  const candidates: RolaProxyCandidate[] = [];
  for (const row of rows) {
    const ip = row[indexes.ip]?.trim() ?? "";
    const port = numberFrom(row[indexes.port] ?? "");
    const parsedProtocol = protocol(row[indexes.protocol] ?? "");
    if (!publicIpv4(ip) || !port || !Number.isInteger(port) || port < 1 || port > 65_535 || !parsedProtocol) continue;
    // Rola's HTTPS label means the proxy can tunnel HTTPS targets via CONNECT;
    // the proxy listener itself is still a plain HTTP endpoint.
    const scheme = parsedProtocol === "HTTPS" ? "http" : parsedProtocol.toLocaleLowerCase();
    const canonical = parseProxyImportLine(`${scheme}://${ip}:${port}`, proxyKind(parsedProtocol));
    if (seen.has(canonical.url)) continue;
    seen.add(canonical.url);
    candidates.push({
      url: canonical.url,
      kind: canonical.kind,
      ip,
      port,
      protocol: parsedProtocol,
      metadata: {
        ...(indexes.country >= 0 && row[indexes.country] ? { country: row[indexes.country] } : {}),
        ...(indexes.anonymity >= 0 && row[indexes.anonymity] ? { anonymity: row[indexes.anonymity] } : {}),
        ...(indexes.latency >= 0 && numberFrom(row[indexes.latency] ?? "") !== undefined ? { reportedLatencyMs: numberFrom(row[indexes.latency] ?? "") } : {}),
        ...(indexes.uptime >= 0 && numberFrom(row[indexes.uptime] ?? "") !== undefined ? { reportedUptimePercent: numberFrom(row[indexes.uptime] ?? "") } : {}),
        ...(indexes.checked >= 0 && row[indexes.checked] ? { sourceCheckedAt: row[indexes.checked] } : {}),
        sourceUrl,
      },
    });
  }
  if (rows.length > 0 && candidates.length === 0) throw new Error("Rola proxy table contained no usable public IPv4 candidates.");
  const protocolRank: Record<RolaProxyCandidate["protocol"], number> = { SOCKS5: 0, HTTPS: 1, SOCKS4: 2, HTTP: 3 };
  candidates.sort((left, right) =>
    protocolRank[left.protocol] - protocolRank[right.protocol]
    || (left.metadata.anonymity === "Elite" ? 0 : 1) - (right.metadata.anonymity === "Elite" ? 0 : 1)
    || (right.metadata.reportedUptimePercent ?? -1) - (left.metadata.reportedUptimePercent ?? -1)
    || (left.metadata.reportedLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.metadata.reportedLatencyMs ?? Number.MAX_SAFE_INTEGER));
  return candidates;
}

export async function fetchRolaProxyCandidates(signal?: AbortSignal): Promise<RolaProxyCandidate[]> {
  const response = await fetch(ROLA_FREE_PROXY_URL, {
    headers: { Accept: "text/html", "User-Agent": "DeepInfraGateway/3.17 proxy-sync" },
    signal,
  });
  if (!response.ok) throw new Error(`Rola proxy source returned HTTP ${response.status}.`);
  const html = await response.text();
  const current = parseRolaProxyHtml(html, ROLA_FREE_PROXY_URL);
  const dailyPath = /href="([^"]*\/tools\/free-proxy-list\/\d{4}-\d{2}-\d{2}\/?)"/i.exec(html)?.[1];
  if (!dailyPath) return current;
  try {
    const dailyUrl = new URL(dailyPath, ROLA_FREE_PROXY_URL).href;
    const dailyResponse = await fetch(dailyUrl, {
      headers: { Accept: "text/html", "User-Agent": "DeepInfraGateway/3.17 proxy-sync" },
      signal,
    });
    if (!dailyResponse.ok) return current;
    const daily = parseRolaProxyHtml(await dailyResponse.text(), dailyUrl);
    const byUrl = new Map<string, RolaProxyCandidate>();
    for (const candidate of [...current, ...daily]) byUrl.set(candidate.url, candidate);
    const merged = [...byUrl.values()];
    const protocolRank: Record<RolaProxyCandidate["protocol"], number> = { SOCKS5: 0, HTTPS: 1, SOCKS4: 2, HTTP: 3 };
    merged.sort((left, right) => protocolRank[left.protocol] - protocolRank[right.protocol]
      || (left.metadata.anonymity === "Elite" ? 0 : 1) - (right.metadata.anonymity === "Elite" ? 0 : 1)
      || (right.metadata.reportedUptimePercent ?? -1) - (left.metadata.reportedUptimePercent ?? -1)
      || (left.metadata.reportedLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.metadata.reportedLatencyMs ?? Number.MAX_SAFE_INTEGER));
    return merged;
  } catch {
    return current;
  }
}
