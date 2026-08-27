import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CdpSession, findPageTarget, MintError } from "./cdp.ts";
import { browserProxyTarget, type BrowserProxyTarget } from "./proxy.ts";
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
const DOCUMENT_PATTERN = "https://deepinfra.com/*";

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
  private boundProxyUrl: string | undefined;
  private target: BrowserProxyTarget | undefined;
  private warmed = false;
  private widgetSeq = 0;
  private siteKey: string;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private minting = false;

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

  /** Mints one token through `proxyUrl`, restarting the browser if it changed. */
  async mint(proxyUrl: string): Promise<MintResult> {
    this.minting = true;
    this.cancelIdleRelease();
    try {
      if (this.boundProxyUrl !== proxyUrl) {
        await this.close();
        const target = browserProxyTarget(proxyUrl);
        if (!target) throw new MintError("proxy_auth_failed", "The leased proxy cannot drive a browser.");
        this.target = target;
        this.boundProxyUrl = proxyUrl;
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
      return await this.mintOnce(session);
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
    const page = await this.ensurePage();
    if (!page.webSocketDebuggerUrl) throw new MintError("cdp_unreachable", "The page target is not attachable.");
    const session = await CdpSession.open(page.webSocketDebuggerUrl);
    await session.send("Page.enable");
    // handleAuthRequests lets Fetch.authRequired answer HTTP proxy auth, which
    // Chrome cannot take from the --proxy-server URL.
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: DOCUMENT_PATTERN, requestStage: "Request" }],
      handleAuthRequests: true,
    });
    const body = trapPageBase64(this.siteKey);
    session.watch({
      onPaused: (request) => {
        // Replace the first HTML document; let sub-resources through untouched.
        if (request.url.startsWith("https://deepinfra.com/") && !request.url.includes("/api/")) {
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
      onAuthRequired: (event) => {
        const target = this.target;
        session.post("Fetch.continueWithAuth", {
          requestId: event.requestId,
          authChallengeResponse: target?.username
            ? { response: "ProvideCredentials", username: target.username, password: target.password ?? "" }
            : { response: "Default" },
        });
      },
    });
    await session.send("Page.navigate", { url: CHALLENGE_ORIGIN });
    await this.waitForTrapPage(session);
    this.session = session;
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

  private async ensurePage(): Promise<{ webSocketDebuggerUrl?: string }> {
    const existing = await findPageTarget(this.options.port);
    if (existing) return existing;
    this.killProcess();
    await this.launch();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(1_000);
      const page = await findPageTarget(this.options.port);
      if (page) return page;
    }
    throw new MintError("browser_timeout", "The browser did not expose a page target.");
  }

  private async launch(): Promise<void> {
    const executablePath = detectExecutable(this.options.executablePath);
    await mkdir(this.options.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.options.port}`,
      `--user-data-dir=${this.options.profileDir}`,
      ...LEAN_LAUNCH_FLAGS,
      ...platformLaunchFlags(),
    ];
    if (this.target) {
      args.push(`--proxy-server=${this.target.server}`);
      // Keep the CDP loopback connection off the proxy.
      args.push("--proxy-bypass-list=<-loopback>");
    }
    args.push(CHALLENGE_ORIGIN);

    this.process = spawn(executablePath, args, {
      detached: false,
      stdio: "ignore",
      env: process.platform === "win32"
        ? process.env
        : { ...process.env, DISPLAY: process.env.DISPLAY ?? this.options.display },
    });
    this.process.unref();
  }

  private killProcess(): void {
    this.process?.kill();
    this.process = undefined;
  }

  /** Tears down the CDP session and browser but keeps the proxy binding. */
  private dropSession(): void {
    this.session?.close();
    this.session = undefined;
    this.warmed = false;
    this.widgetSeq = 0;
    this.killProcess();
  }

  /**
   * Captures the resident page for the admin console. Fails fast when the
   * browser is idle-released or mid-restart: a diagnostic must not spawn or
   * reload a browser, which would disturb the minting state machine.
   */
  async screenshot(kind: "page" | "fullpage"): Promise<string> {
    if (!this.session || !this.boundProxyUrl) {
      throw new MintError("browser_missing", "No resident browser is currently running.");
    }
    const result = await this.session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: kind === "fullpage",
      fromSurface: true,
    }) as { data?: string };
    if (typeof result.data !== "string" || !result.data) {
      throw new MintError("cdp_error", "The browser returned no screenshot data.");
    }
    return result.data;
  }

  async close(): Promise<void> {
    this.cancelIdleRelease();
    this.dropSession();
    this.boundProxyUrl = undefined;
    this.target = undefined;
  }
}
