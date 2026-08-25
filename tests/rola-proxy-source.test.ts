import assert from "node:assert/strict";
import test from "node:test";
import { parseRolaProxyHtml } from "../server/utils/rola-proxy-source.ts";

function table(headers: string[], rows: string[][]): string {
  return `<table class="fpl-proxy"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

test("Rola parser maps headers independent of column order and ranks candidates", () => {
  const html = table(
    ["协议", "IP Address", "在线率", "端口", "速度", "国家/地区", "最近检测"],
    [
      ["SOCKS5", "8.8.8.8", "95%", "1080", "80ms", "US", "1 min ago"],
      ["HTTPS", "1.1.1.1", "99%", "443", "120ms", "AU", "2 min ago"],
    ],
  );
  const candidates = parseRolaProxyHtml(html);
  assert.deepEqual(candidates.map((candidate) => [candidate.ip, candidate.kind, candidate.protocol]), [
    ["8.8.8.8", "socks5", "SOCKS5"],
    ["1.1.1.1", "http", "HTTPS"],
  ]);
  assert.equal(candidates[1]?.url, "http://1.1.1.1:443/");
  assert.equal(candidates[1]?.metadata.reportedUptimePercent, 99);
});

test("Rola parser rejects private IPv4, IPv6, invalid ports and duplicate proxies", () => {
  const html = table(
    ["IP Address", "端口", "协议"],
    [
      ["10.0.0.1", "8080", "HTTP"],
      ["2001:4860:4860::8888", "1080", "SOCKS5"],
      ["8.8.8.8", "70000", "SOCKS5"],
      ["8.8.4.4", "1080", "SOCKS5"],
      ["8.8.4.4", "1080", "SOCKS5"],
    ],
  );
  const candidates = parseRolaProxyHtml(html);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.ip, "8.8.4.4");
});

test("Rola parser fails closed when required columns are missing", () => {
  assert.throws(() => parseRolaProxyHtml(table(["国家", "速度"], [["US", "10ms"]])), /missing IP, port or protocol/);
});
