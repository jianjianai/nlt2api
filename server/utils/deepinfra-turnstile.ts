import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * DeepInfra's anonymous web chat requires a fresh Cloudflare Turnstile ticket per
 * request, submitted as `X-DeepInfra-Turnstile`. Observed upstream semantics:
 *
 * - The ticket is single-use. Once DeepInfra redeems it, a replay returns 403
 *   `Captcha verification failed`, so tickets must never be pooled or cached.
 * - The ticket is bound to the widget the page itself renders. A self-rendered
 *   widget using the same site key is rejected, so we drive the page's own send
 *   flow and abort the browser request before it redeems the ticket.
 * - Enabling the CDP Runtime/Console domain trips Cloudflare's automation probe
 *   and fails the challenge with error 600010, so this minter never enables them.
 * - The challenge inspects the real rendering pipeline. Measured per-flag: disabling
 *   images (`--blink-settings=imagesEnabled=false`) or `Translate,MediaRouter` yields
 *   ZERO tickets, while a small offscreen window and `--disable-background-networking`
 *   keep minting and are the fastest configuration. Never trade rendering for memory.
 * - A cold profile never produces a ticket on its first attempt, so the browser is
 *   warmed once at startup and then kept resident; per-mint process restarts are what
 *   made minting cost ~31s instead of ~10s.
 * - Playwright-driven launches (including CloakBrowser, which wraps Playwright) fail
 *   the challenge outright, so the browser is spawned directly and driven over raw CDP.
 */

const CHALLENGE_PAGE = "https://deepinfra.com/moonshotai/Kimi-K3";
const CHAT_URL_PATTERN = "*api.deepinfra.com/v1/openai/chat/completions*";
/**
 * Launch flags verified to preserve minting. The window is small and moved offscreen
 * to cut compositor cost without touching the rendering features the challenge probes.
 */
const LEAN_LAUNCH_FLAGS = [
  "--window-size=800,600",
  "--disable-background-networking",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
];
/**
 * Windows used to move the window offscreen so a real desktop never shows it, which
 * looks like the browser "minimized itself" in local development. The window now stays
 * visible by default; set DEEPINFRA_BROWSER_OFFSCREEN=1 to restore the leaner
 * offscreen placement. On Linux the window lives inside an invisible virtual display,
 * so a negative position only risks confusing the challenge's viewport checks.
 */
const WINDOWS_OFFSCREEN_FLAGS = ["--window-position=-2400,-2400"];
/**
 * The service runs unprivileged with NoNewPrivileges, so Chromium's setuid sandbox
 * cannot initialize; /dev/shm is also small on most VPS images.
 *
 * SwiftShader is REQUIRED, not an optimization: on a headless host inside Xvfb there is
 * no GPU, `webgl` reports false, and the challenge then issues no ticket at all.
 * Measured on the target server — without these flags 0/3 mints, with them a ticket
 * arrives on the first attempt.
 */
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

export interface TurnstileTicket {
  token: string;
  source: string;
  userAgent?: string;
  mintedAt: string;
}

export interface TurnstileMinterOptions {
  /** CDP port of the browser that holds the warmed DeepInfra page. */
  port?: number;
  /** Skip the startup warm-up mint. Only for tests; the first real mint then fails. */
  skipWarmup?: boolean;
  /** Persistent browser profile directory; keeps Cloudflare trust between runs. */
  profileDir?: string;
  /** Browser executable; auto-detected from the common install paths when absent. */
  executablePath?: string;
  /** Milliseconds to wait for the page to settle after a navigation. */
  pageSettleMs?: number;
  /** Milliseconds to wait for one ticket before giving up. */
  mintTimeoutMs?: number;
  /** Idle milliseconds before the resident browser is released. 0 keeps it forever. */
  idleReleaseMs?: number;
}

export class TurnstileMintError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? `Turnstile mint failed: ${reason}`);
    this.name = "TurnstileMintError";
    this.reason = reason;
  }
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function detectExecutable(explicit?: string): string {
  const fromEnv = explicit ?? process.env.DEEPINFRA_BROWSER_PATH;
  if (fromEnv) return fromEnv;
  const candidates = process.platform === "win32" ? WINDOWS_BROWSER_CANDIDATES : LINUX_BROWSER_CANDIDATES;
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new TurnstileMintError(
      "browser_missing",
      "No Chrome, Chromium or Edge install was found for Turnstile minting. "
        + "Install one or set DEEPINFRA_BROWSER_PATH.",
    );
  }
  return found;
}

/** Platform-specific launch flags on top of the verified lean set. */
function platformLaunchFlags(): string[] {
  if (process.platform === "win32") {
    return process.env.DEEPINFRA_BROWSER_OFFSCREEN === "1" ? WINDOWS_OFFSCREEN_FLAGS : [];
  }
  return LINUX_LAUNCH_FLAGS;
}

async function listTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new TurnstileMintError("cdp_unreachable", `CDP list failed with ${response.status}.`);
  return (await response.json()) as CdpTarget[];
}

async function findPage(port: number): Promise<CdpTarget | undefined> {
  try {
    const targets = await listTargets(port);
    return targets.find((target) => target.type === "page" && target.url.includes("deepinfra.com"));
  } catch {
    return undefined;
  }
}

type PausedHandler = (requestId: string, method: string, headers: Record<string, string>) => void;

/** Minimal CDP client. Runtime/Console domains stay disabled to avoid the automation probe. */
class CdpSession {
  private readonly socket: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private onPaused: PausedHandler | undefined;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.onmessage = (event: MessageEvent) => this.dispatch(String(event.data));
  }

  static async open(webSocketUrl: string): Promise<CdpSession> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new TurnstileMintError("cdp_socket", "Failed to open the CDP socket."));
    });
    return new CdpSession(socket);
  }

  private dispatch(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      method?: string;
      error?: { message: string };
      result?: unknown;
      params?: { requestId: string; request: { method: string; headers: Record<string, string> } };
    };
    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      message.error ? waiter.reject(new TurnstileMintError("cdp_error", message.error.message)) : waiter.resolve(message.result);
      return;
    }
    if (message.method === "Fetch.requestPaused" && message.params && this.onPaused) {
      this.onPaused(message.params.requestId, message.params.request.method, message.params.request.headers ?? {});
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.seq;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TurnstileMintError("cdp_timeout", `CDP call timed out: ${method}`));
      }, 45_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  /** Fire-and-forget for the paused-request callbacks, where no reply is needed. */
  post(method: string, params: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ id: ++this.seq, method, params }));
  }

  watchPaused(handler: PausedHandler | undefined): void {
    this.onPaused = handler;
  }

  close(): void {
    this.socket.close();
  }
}

const SET_PROMPT = (label: string) => `(()=>{const i=document.querySelector('textarea[aria-label="chatbot input prompt"]');`
  + `if(!i)return'missing';const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;`
  + `s.call(i,${JSON.stringify(label)});i.dispatchEvent(new Event('input',{bubbles:true}));return'ok'})()`;

const CLICK_SEND = `(()=>{const b=[...document.querySelectorAll('button')]`
  + `.find(x=>x.textContent.trim().toLowerCase()==='send message');`
  + `if(!b)return'missing';if(b.disabled)return'disabled';b.click();return'clicked'})()`;

const READY_PROBE = `(()=>{const i=document.querySelector('textarea[aria-label="chatbot input prompt"]');`
  + `const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().toLowerCase()==='send message');`
  + `return Boolean(i&&b)})()`;

/**
 * Mints one single-use Turnstile ticket per call by letting the real DeepInfra page
 * solve the challenge, then aborting the page's own chat request so the ticket stays
 * unredeemed and can be attached to a downstream gateway request instead.
 *
 * Mint calls are serialized: the page has one challenge widget, so concurrent mints
 * would race on the same widget state and yield no ticket.
 */
export class DeepInfraTurnstileMinter {
  private readonly port: number;
  private readonly profileDir: string;
  private readonly executablePath: string | undefined;
  private readonly pageSettleMs: number;
  private readonly mintTimeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private browser: ReturnType<typeof spawn> | undefined;
  /** Reused across mints; reconnecting per mint costs a full page load. */
  private session: CdpSession | undefined;
  private warmed = false;
  private readonly skipWarmup: boolean;
  private readonly idleReleaseMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight mints; the idle reclaimer must never close the browser under one. */
  private active = 0;
  private closed = false;

  constructor(options: TurnstileMinterOptions = {}) {
    this.port = options.port ?? 9333;
    this.skipWarmup = options.skipWarmup === true;
    // Must stay OUTSIDE the workspace: Edge rewrites lock/temp files constantly and a
    // dev-server file watcher inside the project crashes with EBUSY on them.
    this.profileDir = options.profileDir
      ?? process.env.DEEPINFRA_PROFILE_DIR
      ?? join(tmpdir(), "breezell-deepinfra-profile");
    this.executablePath = options.executablePath;
    this.pageSettleMs = options.pageSettleMs ?? 15_000;
    this.mintTimeoutMs = options.mintTimeoutMs ?? 30_000;
    this.idleReleaseMs = options.idleReleaseMs ?? 10 * 60_000;
  }

  async mint(): Promise<TurnstileTicket> {
    if (this.closed) throw new TurnstileMintError("closed", "The challenge minter is shutting down.");
    this.active += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const run = this.queue.then(() => this.mintSerialized(), () => this.mintSerialized());
    this.queue = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.active -= 1;
      if (this.active === 0) this.scheduleIdleRelease();
    }
  }

  /**
   * A cold profile always fails its first challenge, so the first mint absorbs that
   * throwaway attempt instead of surfacing it as a downstream 503.
   */
  private async mintSerialized(): Promise<TurnstileTicket> {
    if (this.closed) throw new TurnstileMintError("closed", "The challenge minter is shutting down.");
    if (!this.warmed && !this.skipWarmup) {
      this.warmed = true;
      await this.mintOnce().catch(() => undefined);
    }
    return this.mintOnce();
  }

  private async mintOnce(): Promise<TurnstileTicket> {
    const session = await this.ensureSession();
    try {
      // A reload is required per mint: a page whose challenge was already executed
      // stops issuing tickets, and leftover chat history changes the outgoing body.
      await session.send("Page.navigate", { url: CHALLENGE_PAGE });
      await this.waitForChallenge(session);
      let resolveTicket: ((headers: Record<string, string> | null) => void) | undefined;
      const ticketHeaders = new Promise<Record<string, string> | null>((resolve) => { resolveTicket = resolve; });
      session.watchPaused((requestId, method, headers) => {
        const key = Object.keys(headers).find((name) => name.toLowerCase() === "x-deepinfra-turnstile");
        if (method === "POST" && key && resolveTicket) {
          const settle = resolveTicket;
          resolveTicket = undefined;
          // Abort so DeepInfra never redeems this ticket; the gateway spends it instead.
          session.post("Fetch.failRequest", { requestId, errorReason: "Aborted" });
          settle(headers);
          return;
        }
        session.post("Fetch.continueRequest", { requestId });
      });
      await this.evaluate(session, SET_PROMPT("ping"));
      await delay(900);
      const clicked = await this.evaluate(session, CLICK_SEND);
      if (clicked !== "clicked") throw new TurnstileMintError("send_unavailable", `Challenge send control was ${String(clicked)}.`);
      const headers = await Promise.race([ticketHeaders, delay(this.mintTimeoutMs).then(() => null)]);
      if (!headers) throw new TurnstileMintError("no_ticket", "The page produced no Turnstile ticket in time.");

      const key = Object.keys(headers).find((name) => name.toLowerCase() === "x-deepinfra-turnstile");
      const ticket: TurnstileTicket = {
        token: String(headers[key as string]),
        source: headers["X-Deepinfra-Source"] ?? headers["x-deepinfra-source"] ?? "model-embed",
        mintedAt: new Date().toISOString(),
        ...(headers["User-Agent"] ? { userAgent: headers["User-Agent"] } : {}),
      };
      return ticket;
    } catch (error) {
      // A broken pipe or dead tab must not poison every later mint.
      this.dropSession();
      throw error;
    } finally {
      this.session?.watchPaused(undefined);
    }
  }

  /** Opens the CDP session once and reuses it for every later mint. */
  private async ensureSession(): Promise<CdpSession> {
    if (this.closed) throw new TurnstileMintError("closed", "The challenge minter is shutting down.");
    if (this.session) return this.session;
    const page = await this.ensurePage();
    if (!page.webSocketDebuggerUrl) {
      throw new TurnstileMintError("page_missing", "DeepInfra challenge page is not attachable.");
    }
    const session = await CdpSession.open(page.webSocketDebuggerUrl);
    await session.send("Page.enable");
    await session.send("Fetch.enable", { patterns: [{ urlPattern: CHAT_URL_PATTERN, requestStage: "Request" }] });
    this.session = session;
    return session;
  }

  private dropSession(): void {
    this.session?.watchPaused(undefined);
    this.session?.close();
    this.session = undefined;
  }

  /**
   * Evaluates in the page's main world WITHOUT enabling the Runtime domain. Enabling
   * Runtime (or Console) trips Cloudflare's automation probe and fails the challenge
   * with error 600010; a bare `Runtime.evaluate` call does not.
   */
  private async evaluate(session: CdpSession, expression: string): Promise<unknown> {
    const result = (await session.send("Runtime.evaluate", { expression, returnByValue: true })) as {
      result?: { value?: unknown };
    };
    return result.result?.value;
  }

  /** Waits for the chat control and the Turnstile widget frame to be present. */
  private async waitForChallenge(session: CdpSession): Promise<void> {
    const deadline = Date.now() + this.pageSettleMs;
    while (Date.now() < deadline) {
      await delay(1_000);
      const ready = await this.evaluate(session, READY_PROBE).catch(() => false);
      if (ready === true) {
        // The widget needs a moment after mount before it will produce a ticket.
        await delay(2_500);
        return;
      }
    }
    throw new TurnstileMintError("page_not_ready", "The challenge page did not become ready in time.");
  }

  private async ensurePage(): Promise<CdpTarget> {
    const existing = await findPage(this.port);
    if (existing) return existing;
    // A dead or unreachable browser must be reaped before respawning, otherwise the
    // old process keeps the debugging port and its memory.
    this.killBrowser();
    await this.launchBrowser();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(1_000);
      const page = await findPage(this.port);
      if (page) {
        await delay(this.pageSettleMs);
        return page;
      }
    }
    throw new TurnstileMintError("browser_timeout", "The challenge browser did not expose the DeepInfra page.");
  }

  private async launchBrowser(): Promise<void> {
    if (this.closed) throw new TurnstileMintError("closed", "The challenge minter is shutting down.");
    const executablePath = detectExecutable(this.executablePath);
    await mkdir(this.profileDir, { recursive: true });
    this.browser = spawn(executablePath, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      ...LEAN_LAUNCH_FLAGS,
      ...platformLaunchFlags(),
      CHALLENGE_PAGE,
    ], {
      detached: false,
      stdio: "ignore",
      // The challenge rejects headless mode, so a headless host must provide a virtual
      // display (Xvfb). DEEPINFRA_DISPLAY names it when the service env has no DISPLAY.
      env: process.platform === "win32"
        ? process.env
        : { ...process.env, DISPLAY: process.env.DEEPINFRA_DISPLAY ?? process.env.DISPLAY ?? ":99" },
    });
    this.browser.unref();
  }

  /**
   * Releases the resident browser after an idle period. The browser costs ~1.6 GB, so a
   * gateway that stops serving free traffic should not keep paying for it; the next mint
   * transparently relaunches and re-warms.
   */
  private scheduleIdleRelease(): void {
    if (this.idleReleaseMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // Never reclaim mid-mint: the queue owns the browser until it drains.
      if (this.active > 0) {
        this.scheduleIdleRelease();
        return;
      }
      void this.close().catch(() => undefined);
    }, this.idleReleaseMs);
    this.idleTimer.unref?.();
  }

  private killBrowser(): void {
    this.browser?.kill();
    this.browser = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.dropSession();
    this.warmed = false;
    this.killBrowser();
  }
}

export class DeepInfraTurnstilePool {
  private readonly minters: DeepInfraTurnstileMinter[];
  private nextIndex = 0;

  constructor(options: TurnstileMinterOptions = {}, size = Number(process.env.DEEPINFRA_TURNSTILE_MINTERS ?? "2")) {
    const count = Number.isInteger(size) && size > 0 ? Math.min(size, 8) : 2;
    const basePort = options.port ?? Number(process.env.DEEPINFRA_TURNSTILE_BASE_PORT ?? "9333");
    const baseProfile = options.profileDir ?? process.env.DEEPINFRA_PROFILE_DIR ?? join(tmpdir(), "breezell-deepinfra-profile");
    this.minters = Array.from({ length: count }, (_, index) => new DeepInfraTurnstileMinter({
      ...options,
      port: basePort + index,
      profileDir: count === 1 ? baseProfile : `${baseProfile}-${index + 1}`,
    }));
  }

  mint(): Promise<TurnstileTicket> {
    const minter = this.minters[this.nextIndex % this.minters.length]!;
    this.nextIndex = (this.nextIndex + 1) % this.minters.length;
    return minter.mint();
  }

  async close(): Promise<void> {
    await Promise.all(this.minters.map((minter) => minter.close()));
  }
}

let sharedMinter: DeepInfraTurnstilePool | undefined;

export function deepInfraTurnstileMinter(): DeepInfraTurnstilePool {
  sharedMinter ??= new DeepInfraTurnstilePool();
  return sharedMinter;
}

export async function closeDeepInfraTurnstileMinter(): Promise<void> {
  const previous = sharedMinter;
  sharedMinter = undefined;
  await previous?.close();
}

export function resetDeepInfraTurnstileMinterForTests(): void {
  const previous = sharedMinter;
  sharedMinter = undefined;
  void previous?.close().catch(() => undefined);
}
