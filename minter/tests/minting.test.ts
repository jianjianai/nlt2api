import assert from "node:assert/strict";
import { test } from "node:test";
import { MintError } from "~/src/cdp.ts";
import { blamesProxy, classifyMintFailure } from "~/src/failure.ts";
import { parseUpstreamTarget } from "~/src/local-proxy.ts";
import { maskProxyUrl, redactProxyUrls } from "~/src/proxy.ts";
import { platformLaunchFlags } from "~/src/browser.ts";
import { trapPageBase64, trapPageHtml, trapPageScript } from "~/src/trap-page.ts";

interface FakeElement {
  id: string;
  children: FakeElement[];
  appendChild(child: FakeElement): void;
  remove(): void;
  readonly childElementCount: number;
}

interface RenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback": (code: string) => void;
}

interface TrapPage {
  mint(id: string): Promise<string>;
  solve(token: string): void;
  fail(code: string): void;
  widgets(): number;
  settle(): Promise<void>;
  readonly siteKeys: string[];
  readonly removed: number[];
}
function createElement(id: string, parent?: FakeElement): FakeElement {
  const children: FakeElement[] = [];
  const element: FakeElement = {
    id,
    children,
    appendChild(child) {
      children.push(child);
    },
    remove() {
      if (!parent) return;
      const index = parent.children.indexOf(element);
      if (index >= 0) parent.children.splice(index, 1);
    },
    get childElementCount() {
      return children.length;
    },
  };
  return element;
}

/**
 * Runs the trap page's own script against a minimal DOM and Turnstile stub, so
 * the widget lifecycle is exercised rather than asserted on by string matching.
 */
function runTrapPage(siteKey: string): TrapPage {
  const root = createElement("root");
  const siteKeys: string[] = [];
  const removed: number[] = [];
  const rendered: RenderOptions[] = [];
  const scope: Record<string, unknown> = {};
  const host = {
    get __mint() {
      return scope.__mint as (id: string) => Promise<string>;
    },
    get __widgets() {
      return scope.__widgets as () => number;
    },
    turnstile: {
      render(target: FakeElement, options: RenderOptions): number {
        siteKeys.push(options.sitekey);
        rendered.push(options);
        // The DOM child is the container; the widget id is Turnstile's handle.
        void target;
        return rendered.length - 1;
      },
      remove(widgetId: number): void {
        removed.push(widgetId);
      },
    },
  };
  const document = {
    createElement: (_tag: string) => createElement("", root),
    getElementById: (id: string) => (id === "root" ? root : undefined),
  };
  const assign = new Function("window", "document", "setTimeout", `${trapPageScript(siteKey)}`);
  const windowProxy = new Proxy(host as Record<string, unknown>, {
    get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : scope[key as string]),
    set: (_target, key, value) => {
      scope[key as string] = value;
      return true;
    },
    has: (target, key) => key in target || key in scope,
  });
  assign(windowProxy, document, setTimeout);

  const latest = () => rendered[rendered.length - 1];
  return {
    siteKeys,
    removed,
    mint: (id) => (scope.__mint as (value: string) => Promise<string>)(id),
    solve: (token) => latest()?.callback(token),
    fail: (code) => latest()?.["error-callback"](code),
    widgets: () => root.childElementCount,
    // dispose() is deferred by one task, so tests must yield before asserting.
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

test("parseUpstreamTarget accepts credentialed http and socks proxies", () => {
  // The forwarder owns upstream auth, so credentialed SOCKS is fine now.
  assert.deepEqual(parseUpstreamTarget("http://bob:secret@1.2.3.4:8080"), {
    kind: "http",
    host: "1.2.3.4",
    port: 8080,
    username: "bob",
    password: "secret",
  });
  assert.deepEqual(parseUpstreamTarget("http://1.2.3.4:8080"), { kind: "http", host: "1.2.3.4", port: 8080 });
  assert.deepEqual(parseUpstreamTarget("socks5://bob:secret@1.2.3.4:1080"), {
    kind: "socks5",
    host: "1.2.3.4",
    port: 1080,
    username: "bob",
    password: "secret",
  });
});

test("parseUpstreamTarget defaults ports per scheme and maps aliases", () => {
  assert.equal(parseUpstreamTarget("http://1.2.3.4")?.port, 80);
  assert.equal(parseUpstreamTarget("https://1.2.3.4")?.kind, "http");
  assert.equal(parseUpstreamTarget("socks5h://1.2.3.4")?.kind, "socks5");
  assert.equal(parseUpstreamTarget("socks4a://1.2.3.4:1080")?.kind, "socks4");
  assert.equal(parseUpstreamTarget("socks4a://1.2.3.4")?.port, 1080);
});

test("parseUpstreamTarget rejects non-proxy URLs", () => {
  assert.equal(parseUpstreamTarget("ftp://1.2.3.4:21"), undefined);
  assert.equal(parseUpstreamTarget("garbage"), undefined);
  assert.equal(parseUpstreamTarget("http://"), undefined);
});

test("maskProxyUrl never leaks the password", () => {
  assert.equal(maskProxyUrl("http://bobby:secret@1.2.3.4:8080"), "http://bo***@1.2.3.4:8080");
  assert.equal(maskProxyUrl("http://1.2.3.4:8080"), "http://1.2.3.4:8080");
  assert.equal(maskProxyUrl("nonsense"), "***");
});

test("redactProxyUrls strips credentials but keeps the rest of the message", () => {
  assert.equal(
    redactProxyUrls("connect ECONNREFUSED via http://bobby:secret@1.2.3.4:8080 after 3s"),
    "connect ECONNREFUSED via http://bo***@1.2.3.4:8080 after 3s",
  );
  assert.equal(redactProxyUrls("CDP call timed out: Runtime.evaluate"), "CDP call timed out: Runtime.evaluate");
});

test("the trap page embeds the site key and installs the mint hooks", () => {
  const html = trapPageHtml("0xTESTKEY");
  assert.ok(html.includes("0xTESTKEY"));
  assert.ok(html.includes("challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"));
  assert.ok(html.includes("window.__mint"));
  assert.ok(html.includes("window.__ready"));
  // error-callback must be wired, otherwise a Cloudflare failure hangs the mint.
  assert.ok(html.includes("error-callback"));
});

test("the trap page body round-trips through base64 for fulfillRequest", () => {
  const html = trapPageHtml("0xKEY");
  assert.equal(Buffer.from(trapPageBase64("0xKEY"), "base64").toString("utf8"), html);
});

test("a solved widget is removed so a resident page does not grow per mint", async () => {
  const page = runTrapPage("0xKEY");
  const first = page.mint("w1");
  assert.equal(page.widgets(), 1);
  page.solve("token-1");
  assert.equal(await first, "token-1");
  await page.settle();
  assert.deepEqual(page.removed, [0]);
  assert.equal(page.widgets(), 0);

  const second = page.mint("w2");
  page.solve("token-2");
  assert.equal(await second, "token-2");
  await page.settle();
  // Two mints on one page still leave nothing behind.
  assert.deepEqual(page.removed, [0, 1]);
  assert.equal(page.widgets(), 0);
});

test("a failed widget is removed too, so a retry does not accumulate iframes", async () => {
  const page = runTrapPage("0xKEY");
  const mint = page.mint("w1");
  page.fail("600010");
  await assert.rejects(mint, /turnstile:600010/);
  await page.settle();
  assert.deepEqual(page.removed, [0]);
  assert.equal(page.widgets(), 0);
});

test("Linux launches keep the SwiftShader flags that the challenge requires", () => {
  const flags = platformLaunchFlags("linux");
  for (const flag of ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]) {
    assert.ok(flags.includes(flag), `missing ${flag}`);
  }
  assert.deepEqual(platformLaunchFlags("win32"), []);
});

test("MintError reasons pass through classification unchanged", () => {
  assert.deepEqual(classifyMintFailure(new MintError("cdp_timeout", "slow")), { reason: "cdp_timeout", message: "slow" });
});

test("browser transport errors are attributed to the proxy", () => {
  assert.equal(classifyMintFailure(new Error("net::ERR_PROXY_CONNECTION_FAILED")).reason, "proxy_connect_failed");
  assert.equal(classifyMintFailure(new Error("net::ERR_TUNNEL_CONNECTION_FAILED")).reason, "proxy_connect_failed");
  assert.equal(classifyMintFailure(new Error("net::ERR_PROXY_AUTH_UNSUPPORTED")).reason, "proxy_auth_failed");
  assert.equal(classifyMintFailure(new Error("net::ERR_TIMED_OUT")).reason, "proxy_timeout");
});

test("challenge errors are not blamed on the proxy", () => {
  assert.equal(classifyMintFailure(new Error("turnstile:600010")).reason, "challenge_error");
  assert.equal(classifyMintFailure("weird").reason, "challenge_error");
});

test("only transport reasons feed the proxy health signal", () => {
  for (const reason of ["proxy_connect_failed", "proxy_auth_failed", "proxy_timeout"] as const) {
    assert.equal(blamesProxy(reason), true);
  }
  for (const reason of ["browser_missing", "cdp_socket", "no_token", "challenge_error", "aborted"] as const) {
    assert.equal(blamesProxy(reason), false);
  }
});
