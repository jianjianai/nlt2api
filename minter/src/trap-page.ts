/**
 * The page that replaces DeepInfra's own HTML document. Verified experimentally:
 * hijacking the first HTML response and self-rendering a widget with the same
 * site key produces a token the upstream accepts. See
 * docs/designs/2026-08-26-self-rendered-turnstile-design.md.
 *
 * `__mint` renders a fresh widget into a new container each call, so one
 * resident page can produce many tokens without a navigation. Each widget is
 * torn down as soon as its token is in hand: the token is already independent of
 * the widget (it is pooled and spent by another process), while a solved widget
 * keeps an iframe and its challenge state alive, so a long-lived page would grow
 * with every mint.
 */
export function trapPageScript(siteKey: string): string {
  const key = JSON.stringify(siteKey);
  return `window.__ready = () => Boolean(window.turnstile);
window.__mint = (id) => new Promise((resolve, reject) => {
  const host = document.createElement("div");
  host.id = id;
  document.getElementById("root").appendChild(host);
  let widgetId;
  let disposed = false;
  // Deferred by a task: render() has not returned its id yet when the callback
  // fires synchronously, and turnstile.remove() must not run inside a callback
  // of the widget being removed.
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    setTimeout(() => {
      try { if (widgetId !== undefined) window.turnstile.remove(widgetId); } catch (error) { /* already gone */ }
      host.remove();
    }, 0);
  };
  const start = () => {
    if (!window.turnstile) { setTimeout(start, 100); return; }
    try {
      widgetId = window.turnstile.render(host, {
        sitekey: ${key},
        callback: (token) => { dispose(); resolve(token); },
        "error-callback": (code) => { dispose(); reject(new Error("turnstile:" + code)); },
      });
    } catch (error) { dispose(); reject(error); }
  };
  start();
});`;
}

export function trapPageHtml(siteKey: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>
<div id="root"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
<script>
${trapPageScript(siteKey)}
</script></body></html>`;
}

export function trapPageBase64(siteKey: string): string {
  return Buffer.from(trapPageHtml(siteKey), "utf8").toString("base64");
}
