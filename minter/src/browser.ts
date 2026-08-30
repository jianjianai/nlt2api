import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CdpSession, findPageTarget, MintError } from "./cdp.ts";
import type { CdpTarget } from "./cdp.ts";
import { LocalForwardProxy, parseUpstreamTarget } from "./local-proxy.ts";
import { trapPageBase64 } from "./trap-page.ts";

/**
 * Launch constraints below are all measured, not guesses (carried over from the
 * single-process implementation this service replaces):
 *
 * - Playwright/Puppeteer-driven launches fail the challenge outright, so the
 *   browser is spawned directly and driven over raw CDP.
 * - Disabling images (`--blink-settings=imagesEnabled=false`) or the
 *   Translate/MediaRouter features yields ZERO tokens. Never trade rendering
 *   for memory.
 * - On Linux SwiftShader is REQUIRED: with no GPU, `webgl` reports false and
 *   the challenge issues no token at all.
 * - The challenge rejects headless mode, so a headless host must provide a
 *   virtual display (Xvfb).
 * - A cold profile never produces a token on its first attempt, so the first
 *   mint is a warm-up whose result is discarded.
 */
const LEAN_LAUNCH_FLAGS = [
  "--window-size=800,600",
  "--disable-background-networking",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
];

const LINUX_LAUNCH_FLAGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

const WINDOWS_BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const LINUX_BROWSER_CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
];

const CHALLENGE_ORIGIN = "https://deepinfra.com/";
/**
 * Every request must pass through the Fetch domain so the trap page can be
 * substituted for the deepinfra document. Proxy auth is NO LONGER answered
 * here: the loopback forward proxy injects upstream credentials itself, so
 * `Fetch.enable` does not need handleAuthRequests and any stray authRequired
 * is answered with Default.
 */
const INTERCEPT_PATTERN = "*";

/**
 * Resolves the browser binary. A configured path that does not exist falls back
 * to platform detection instead of spawning something that cannot start — that
 * mismatch (Linux paths in a Windows env file) is a common local-dev failure.
 */
export function detectExecutable(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = process.platform === "win32" ? WINDOWS_BROWSER_CANDIDATES : LINUX_BROWSER_CANDIDATES;
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new MintError(
      "browser_missing",
      "No Chrome, Chromium or Edge install was found. Install one or set MINTER_BROWSER_PATH.",
    );
  }
  return found;
}

export function platformLaunchFlags(platform: string = process.platform): string[] {
  return platform === "win32" ? [] : LINUX_LAUNCH_FLAGS;
}

export interface BrowserOptions {
  /** CDP port this browser listens on. */
  port: number;
  profileDir: string;
  display: string;
  siteKey: string;
  mintTimeoutMs: number;
  /** Idle milliseconds before the resident browser is released. 0 keeps it forever. */
  idleReleaseMs: number;
  executablePath?: string;
}

export interface MintResult {
  token: string;
  mintedAt: number;
  userAgent?: string;
}

/**
 * One resident browser bound to one proxy. `--proxy-server` can only be set at
 * launch, so switching proxies restarts the process; minting several tokens on
 * the same lease amortises that cost.
 */
export class MinterBrowser {
  private process: ChildProcess | undefined;
  private session: CdpSession | undefined;
  /** CDP target id of the challenge tab; used to close just that tab on proxy switch. */
  private tabId: string | undefined;
  private readonly forwardProxy = new LocalForwardProxy();
  private boundProxyUrl: string | undefined;
  private warmed = false;
  private widgetSeq = 0;
  private siteKey: string;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private minting = false;
  /** Resolves as soon as the child announces its DevTools socket on stderr. */
  private devtoolsReady: Promise<void> | undefined;

  constructor(private readonly options: BrowserOptions) {
    this.siteKey = options.siteKey;
  }

  setSiteKey(siteKey: string): void {
    if (siteKey === this.siteKey) return;
    // The trap page bakes the key in, so a change invalidates the resident page.
    this.siteKey = siteKey;
    void this.close();
  }

  get proxyUrl(): string | undefined {
    return this.boundProxyUrl;
  }

  /**
   * Mints one token through `proxyUrl`. The browser process stays up across
   * proxy changes: only the tab, cookies and the forward proxy's upstream are
   * swapped, which is dramatically cheaper than a process restart.
   */
  async mint(proxyUrl: string): Promise<MintResult> {
    this.minting = true;
    this.cancelIdleRelease();
    try {
      if (this.boundProxyUrl !== proxyUrl) {
        await this.switchUpstream(proxyUrl);
      }
      const session = await this.ensureSession();
      if (!this.warmed) {
        this.warmed = true;
        // A cold profile always fails its first challenge; absorb it here so the
        // gateway does not see a spurious failure.
        await this.mintOnce(session).catch(() => undefined);
        // A failed warm-up drops the session, so re-establish before the attempt
        // whose result is actually reported.
        return await this.mintOnce(await this.ensureSession());
      }
      try {
        return await this.mintOnce(session);
      } catch (error) {
        // The first failure may leave the browser bound to a dead loopback
        // proxy port (or a zombie process) where every later attempt repeats
        // the same "fetch failed". Tear down and retry once, which relaunches
        // on the remembered port, before reporting the mint as failed.
        this.dropSession();
        return await this.mintOnce(await this.ensureSession());
      }
    } finally {
      this.minting = false;
      this.scheduleIdleRelease();
    }
  }

  /**
   * Releases the resident browser after an idle period; each instance costs
   * roughly 1.6 GB. The next mint relaunches and re-warms transparently.
   */
  private scheduleIdleRelease(): void {
    if (this.options.idleReleaseMs <= 0 || !this.session) return;
    this.cancelIdleRelease();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.minting) {
        this.scheduleIdleRelease();
        return;
      }
      void this.close().catch(() => undefined);
    }, this.options.idleReleaseMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleRelease(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async mintOnce(session: CdpSession): Promise<MintResult> {
    const id = `w${++this.widgetSeq}`;
    try {
      const ready = await session.evaluate<boolean>("typeof window.__mint === 'function'");
      if (ready !== true) throw new MintError("page_not_ready", "The trap page did not install its mint hook.");
      const token = await Promise.race([
        session.evaluate<string>(`window.__mint(${JSON.stringify(id)})`, true),
        delay(this.options.mintTimeoutMs).then(() => {
          throw new MintError("no_token", "The widget produced no token in time.");
        }),
      ]);
      if (typeof token !== "string" || !token) throw new MintError("no_token", "The widget returned an empty token.");
      const userAgent = await session.evaluate<string>("navigator.userAgent").catch(() => undefined);
      return {
        token,
        mintedAt: Date.now(),
        ...(userAgent ? { userAgent } : {}),
      };
    } catch (error) {
      // A dead tab or broken pipe must not poison every later mint. The proxy
      // binding survives so a relaunch keeps using the same lease.
      this.dropSession();
      throw error instanceof MintError ? error : new MintError("challenge_error", String(error));
    }
  }

  private async ensureSession(): Promise<CdpSession> {
    if (this.session) return this.session;
    const page = await this.ensureTab();
    if (!page.webSocketDebuggerUrl) throw new MintError("cdp_unreachable", "The page target is not attachable.");
    this.tabId = page.id;
    const session = await CdpSession.open(page.webSocketDebuggerUrl);
    // Published before the readiness wait so a page stuck loading is still
    // visible to the admin screenshot — that is exactly when it is needed.
    this.session = session;
    try {
      await session.send("Page.enable");
      // handleAuthRequests lets Fetch.authRequired answer HTTP proxy auth, which
      // Chrome cannot take from the --proxy-server URL.
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: INTERCEPT_PATTERN, requestStage: "Request" }],
      });
      const body = trapPageBase64(this.siteKey);
      session.watch({
        onPaused: (request) => {
          // Replace only the top-level document; sub-resources (including the
          // Turnstile script) must pass through untouched.
          if (
            (request.resourceType === undefined || request.resourceType === "Document")
            && request.url.startsWith("https://deepinfra.com/")
            && !request.url.includes("/api/")
          ) {
            session.post("Fetch.fulfillRequest", {
              requestId: request.requestId,
              responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
              body,
            });
            return;
          }
          session.post("Fetch.continueRequest", { requestId: request.requestId });
        },
        // The loopback forward proxy injects upstream credentials, so any
        // authRequired reaching here has nothing to answer — just continue.
        onAuthRequired: (event) => {
          session.post("Fetch.continueWithAuth", {
            requestId: event.requestId,
            authChallengeResponse: { response: "Default" },
          });
        },
      });
      await session.send("Page.navigate", { url: CHALLENGE_ORIGIN });
      await this.waitForTrapPage(session);
    } catch (error) {
      // Without this the socket would stay attached to the page with its Fetch
      // handlers live, and every retry would stack another interceptor on it.
      this.session = undefined;
      session.close();
      throw error;
    }
    return session;
  }

  private async waitForTrapPage(session: CdpSession): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await delay(500);
      const ready = await session.evaluate<boolean>("typeof window.__ready === 'function' && window.__ready()")
        .catch(() => false);
      if (ready === true) return;
    }
    throw new MintError("page_not_ready", "The trap page did not load the Turnstile script in time.");
  }

  /**
   * Finds the challenge tab, or opens one on the resident browser. Launches
   * the process itself when it is not running yet.
   */
  private async ensureTab(): Promise<CdpTarget> {
    await this.launch();
    const existing = await findPageTarget(this.options.port);
    if (existing) return existing;
    return this.openTab();
  }

  /**
   * The user flow for a proxy change: close the challenge tab, clear cookies
   * and cache, point the loopback forwarder at the new lease, then reopen the
   * tab. The browser process itself never restarts.
   */
  private async switchUpstream(proxyUrl: string): Promise<void> {
    if (!parseUpstreamTarget(proxyUrl)) {
      throw new MintError("proxy_auth_failed", "The leased proxy cannot drive a browser.");
    }
    const session = this.session;
    this.session = undefined;
    try {
      if (session) {
        // Close the tab so no request rides out over the OLD upstream. Cached
        // and credentialed state would otherwise leak across proxies.
        if (this.tabId) await session.send("Target.closeTarget", { targetId: this.tabId }).catch(() => undefined);
        this.tabId = undefined;
        await session.send("Network.clearBrowserCookies").catch(() => undefined);
        await session.send("Network.clearBrowserCache").catch(() => undefined);
      }
    } finally {
      session?.close();
    }
    this.forwardProxy.setUpstream(proxyUrl);
    this.boundProxyUrl = proxyUrl;
    // A proxy swap always lands on a fresh tab: warm-up runs again for it.
    this.warmed = false;
    await this.openTab();
  }

  /** Opens a fresh tab on the resident browser so minting has a clean page. */
  private async openTab(): Promise<CdpTarget> {
    await this.launch();
    const port = this.options.port;
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    if (!response.ok) throw new MintError("cdp_unreachable", `Opening a tab failed with ${response.status}.`);
    const target = await response.json() as CdpTarget;
    if (!target.webSocketDebuggerUrl) throw new MintError("cdp_unreachable", "The new tab is not attachable.");
    return target;
  }

  private async launch(): Promise<void> {
    if (this.process && this.devtoolsReady) {
      // Already running; nothing to do.
      return;
    }
    this.killProcess();
    await this.forwardProxy.start();
    const proxyPort = this.forwardProxy.port;
    if (proxyPort === undefined) throw new MintError("cdp_unreachable", "The local forward proxy did not start.");
    const executablePath = detectExecutable(this.options.executablePath);
    await mkdir(this.options.profileDir, { recursive: true });
    // A crashed/killed instance leaves Singleton* lock files behind; Chromium
    // then refuses to start ("profile appears to be in use") and mints never
    // produce a page target. The profile dir is bound to a volume that
    // survives container restarts, so the locks must be cleared here.
    for (const lock of [
      "SingletonLock",
      "SingletonCookie",
      "SingletonSocket",
    ] satisfies string[]) {
      await rm(`${this.options.profileDir}/${lock}`, { force: true }).catch(() => undefined);
    }
    const args = [
      `--remote-debugging-port=${this.options.port}`,
      `--user-data-dir=${this.options.profileDir}`,
      ...LEAN_LAUNCH_FLAGS,
      ...platformLaunchFlags(),
      // The browser always talks to the loopback forwarder; upstream changes
      // are a `setUpstream` call away and never touch this flag.
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--proxy-bypass-list=<-loopback>",
      "about:blank",
    ];

    this.process = spawn(executablePath, args, {
      detached: false,
      // stderr carries the "DevTools listening on ws://…" line that announces
      // the CDP socket; the other streams stay ignored.
      stdio: ["ignore", "ignore", "pipe"],
      env: process.platform === "win32"
        ? process.env
        : { ...process.env, DISPLAY: process.env.DISPLAY ?? this.options.display },
    });
    // A crashed child leaves a non-undefined handle behind; without clearing it
    // the next launch() would treat the dead process as resident and skip
    // spawning, which is exactly the "permanent fetch failed" state.
    this.process.once("exit", () => {
      this.process = undefined;
      this.devtoolsReady = undefined;
    });
    this.watchDevtoolsLine(this.process);
    // Wait for the CDP socket to accept connections. /json/list needs a moment
    // longer to register the page target, so the caller polls findPageTarget.
    await this.devtoolsReady?.catch(() => undefined);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const target = await findPageTarget(this.options.port);
      if (target) return;
      await delay(500);
    }
    throw new MintError("browser_timeout", "The browser did not expose a page target.");
  }

  private watchDevtoolsLine(child: ChildProcess): void {
    const stderr = child.stderr;
    if (!stderr) return;
    let buffer = "";
    this.devtoolsReady = new Promise<void>((resolve) => {
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        buffer += chunk;
        // Only the readiness line matters; the rest of stderr is dropped so a
        // chatty browser cannot leak noise into the service log.
        if (buffer.includes("DevTools listening on ws://")) {
          stderr.removeAllListeners("data");
          stderr.resume();
          resolve();
        }
      });
      stderr.on("end", () => resolve());
      stderr.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  }

  private killProcess(): void {
    this.process?.kill();
    this.process = undefined;
    this.devtoolsReady = undefined;
  }

  /** Tears down the CDP session and browser but keeps the proxy binding. */
  private dropSession(): void {
    this.session?.close();
    this.session = undefined;
    this.tabId = undefined;
    this.warmed = false;
    this.widgetSeq = 0;
    this.killProcess();
    // The forwarder is only ever closed together with the browser above; it
    // must remember its port so the relaunch keeps the same --proxy-server.
    void this.forwardProxy.restart().catch(() => undefined);
  }

  /**
   * Captures the resident page for the admin console. A worker that is between
   * mints has no tab yet, so open one: diagnosing several browsers at once is
   * exactly the multi-instance case the admin is asking about.
   */
  async screenshot(kind: "page" | "fullpage"): Promise<string> {
    this.cancelIdleRelease();
    try {
      if (!this.process && !this.boundProxyUrl) {
        throw new MintError("browser_missing", "No resident browser is currently running.");
      }
      const session = await this.ensureSession();
      const result = await session.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: kind === "fullpage",
        fromSurface: true,
      }) as { data?: string };
      if (typeof result.data !== "string" || !result.data) {
        throw new MintError("cdp_error", "The browser returned no screenshot data.");
      }
      return result.data;
    } finally {
      this.scheduleIdleRelease();
    }
  }

  async close(): Promise<void> {
    this.cancelIdleRelease();
    this.dropSession();
    this.boundProxyUrl = undefined;
  }
}
