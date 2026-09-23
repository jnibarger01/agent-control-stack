// Minimal Chrome DevTools Protocol driver (no dependencies) used by the Mission Control
// E2E and visual-QA scripts. Requires Node's global WebSocket and a local Chrome/Chromium.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

export async function launchBrowser({ port = 9333 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "acs-e2e-chrome-"));
  const bin = CHROME_CANDIDATES[0];
  if (!bin) throw new Error("No Chrome binary found; set CHROME_BIN");
  const proc = spawn(
    bin,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  let version;
  for (let i = 0; i < 100 && !version; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!version) {
    proc.kill();
    throw new Error("Chrome did not start");
  }
  return {
    port,
    async newPage() {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
      return Page.connect(target.webSocketDebuggerUrl);
    },
    async close() {
      proc.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export class Page {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const page = new Page(ws);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    await page.send("Network.enable");
    return page;
  }

  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
    this.cspViolations = [];
    this.requests = [];
    this.loadWaiters = [];
    this.inflight = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === "Page.loadEventFired") for (const wake of this.loadWaiters.splice(0)) wake();
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      } else if (
        msg.method === "Runtime.consoleAPICalled" &&
        (msg.params.type === "error" || msg.params.type === "assert")
      ) {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      } else if (msg.method === "Log.entryAdded") {
        const entry = msg.params.entry;
        if (entry.level === "error") {
          const text = `${entry.text} ${entry.url ?? ""}`;
          if (/Content Security Policy|Refused to/i.test(text)) this.cspViolations.push(text);
          else this.consoleErrors.push(text);
        }
      } else if (msg.method === "Network.requestWillBeSent") {
        this.requests.push({ method: msg.params.request.method, url: msg.params.request.url });
        this.inflight.set(msg.params.requestId, `${msg.params.request.method} ${msg.params.request.url}`);
      } else if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") {
        this.inflight.delete(msg.params.requestId);
      }
    });
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async goto(url) {
    // Wait for the NEW document's load event so assertions never run against the previous page.
    const loaded = new Promise((resolve) => this.loadWaiters.push(resolve));
    await this.send("Page.navigate", { url });
    await Promise.race([
      loaded,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`goto timed out: ${url}`)), 20000))
    ]);
  }

  async eval(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async waitFor(fn, timeout = 8000, ...args) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeout) {
      try {
        // Coerce to boolean inside the page: DOM nodes are not serializable by value.
        last = await this.eval(
          (source, callArgs) => Promise.resolve(new Function(`return (${source})`)()(...callArgs)).then(Boolean),
          fn.toString(),
          args
        );
        if (last) return last;
      } catch {
        /* page navigating */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`waitFor timed out: ${fn.toString().slice(0, 160)}`);
  }

  async click(selector) {
    const ok = await this.eval((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    }, selector);
    if (!ok) throw new Error(`click: no element for ${selector}`);
  }

  async clickText(text, scope = "button, a, [role=tab], tr") {
    const ok = await this.eval(
      (t, s) => {
        const el = [...document.querySelectorAll(s)].find(
          (node) => node.textContent?.trim().startsWith(t) && !node.hasAttribute("disabled")
        );
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      },
      text,
      scope
    );
    if (!ok) throw new Error(`clickText: no enabled element starting with "${text}"`);
  }

  async type(selector, value) {
    await this.eval(
      (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`type: no element for ${sel}`);
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      selector,
      value
    );
  }

  async setViewport(width, height, mobile = false) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  }

  async screenshot(path) {
    await this.send("Page.bringToFront");
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(data, "base64"));
  }

  async close() {
    await this.send("Page.close");
    this.ws.close();
  }
}
