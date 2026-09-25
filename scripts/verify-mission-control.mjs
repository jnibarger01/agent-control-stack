/* global document, window, getComputedStyle, matchMedia, axe, snapshotCurrent, WebSocket, Event */
// Isolated authenticated browser verification. Run after npm run typecheck.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import { buildGateway } from "../apps/gateway/dist/server.js";
import { SqliteWorkItemStore } from "../packages/work-items/dist/index.js";

const scratch = await mkdtemp(join(tmpdir(), "acs-ui-browser-"));
const evidence = process.env.ACS_UI_EVIDENCE_DIR || join(scratch, "evidence");
await mkdir(evidence, { recursive: true });
const dbPath = join(scratch, "fixture.db");
const token = randomBytes(32).toString("hex");
const store = new SqliteWorkItemStore(dbPath);
store.registerActor({ id: "ui-review", actorType: "HUMAN", displayName: "UI review fixture" });
for (const [id, name, status] of [
  ["agent-ui-a", "Investigation worker", "AVAILABLE"],
  ["agent-ui-b", "Runtime observer", "DEGRADED"]
]) {
  store.createRegistryAgent({ id, name, kind: "service", acpRole: "ORCHESTRATION_LAYER", actorId: "ui-review" });
  store.recordAgentHeartbeat(id, { status, currentTask: "Inspect runtime status", actorId: "ui-review" });
}
store.close();
const app = buildGateway({
  dbPath,
  logger: false,
  auth: { token, actor: "ui-review", actorId: "ui-review" },
  acpAdapter: false,
  moa: false,
  sandboxReadiness: { enabled: false }
});
let chrome, ws;
const failures = [];
const results = [];
const runtimeErrors = [];
try {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.equal((await fetch(origin)).status, 401, "unauthenticated dashboard remains denied");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (let index = 0; index < 5; index++) {
    const res = await fetch(origin + "/work-items", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Review runtime evidence " + (index + 1),
        intent: "Inspect the bounded local fixture without executing external actions.",
        target: { services: ["agent-ui-a"] },
        risk: "high",
        requestedActions: [{ kind: "shell", description: "Inspect the fixture", params: { command: "echo fixture" } }]
      })
    });
    assert.ok(res.ok, "fixture work creation accepted");
  }
  const login = await fetch(origin + "/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const profile = join(scratch, "chrome");
  chrome = spawn(
    process.env.CHROME_BIN || "/usr/bin/google-chrome",
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(port, "Chrome started with its normal sandbox");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
      }
    }
    if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (fn, ...args) => {
    const value = await send("Runtime.evaluate", {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
      returnByValue: true,
      awaitPromise: true
    });
    if (value.exceptionDetails)
      throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const waitFor = async (fn) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(fn)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Browser condition timed out: " + fn.toString());
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  const split = cookie.indexOf("=");
  await send("Network.setCookie", {
    name: cookie.slice(0, split),
    value: cookie.slice(split + 1),
    url: origin,
    httpOnly: true,
    sameSite: "Strict"
  });
  await send("Page.navigate", { url: origin });
  await waitFor(() => document.querySelector('[data-freshness="approvals"]')?.dataset.state === "current");
  const require = createRequire(import.meta.url);
  await send("Runtime.evaluate", { expression: await readFile(require.resolve("axe-core/axe.min.js"), "utf8") });
  const views = [
    "overview",
    "queue",
    "execution",
    "approvals",
    "agents",
    "system",
    "audit",
    "connectors",
    "metrics",
    "policy",
    "dispatch"
  ];
  for (const width of [1920, 1440, 1180, 820, 390]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const view of views) {
      await evaluate((view) => {
        const anchor = document.querySelector(`a[data-nav="${view}"]`);
        anchor.click();
        window.scrollTo(0, 0);
      }, view);
      if (view === "agents") {
        await evaluate(() => document.querySelector(".agent-name").click());
        await waitFor(() => document.querySelector("#agent-detail")?.getAttribute("aria-busy") === "false");
      }
      if (view === "system")
        await waitFor(() => document.querySelector("#system-probes")?.getAttribute("aria-busy") === "false");
      const layout = await evaluate(() => ({
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        cardsDisplay: getComputedStyle(document.querySelector("#overview")).display,
        active: document.querySelector('nav [aria-current="page"]')?.dataset.nav,
        panels: [...document.querySelectorAll("[data-view-panel]:not([hidden])")].map((node) => ({
          id: node.id,
          width: node.getBoundingClientRect().width
        }))
      }));
      if (layout.documentWidth > width + 1)
        failures.push(`${width} ${view}: horizontal document overflow ${layout.documentWidth}`);
      if (view === "overview" && layout.cardsDisplay !== "grid") failures.push(`${width}: overview lost its grid`);
      const accessibility = await evaluate(async () =>
        (
          await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })
        ).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) }))
      );
      if (accessibility.length) failures.push({ width, view, accessibility });
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(join(evidence, `${width}-${view}.png`), Buffer.from(shot.data, "base64"));
      results.push({ width, view, layout, accessibility });
    }
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(() => {
    document.querySelector('a[data-nav="approvals"]').click();
    document.querySelector("[data-reason]").value = "Inspected fixture";
    document.querySelector("[data-reject]").focus();
    document.querySelector("[data-reject]").click();
  });
  await waitFor(() => Boolean(document.querySelector('[role="dialog"]')));
  assert.equal(await evaluate(() => document.activeElement.id), "approval-confirm-cancel");
  assert.equal(await evaluate(() => document.querySelector("main").inert), true);
  await evaluate(() => document.querySelector("#approval-confirm-ok").focus());
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate(() => document.activeElement.tagName), "SUMMARY");
  const modalAxe = await evaluate(async () =>
    (await axe.run(document)).violations.map((v) => ({ id: v.id, impact: v.impact }))
  );
  if (modalAxe.length) failures.push({ modalAxe });
  const modalShot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(evidence, "approval-dialog.png"), Buffer.from(modalShot.data, "base64"));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate(() => document.activeElement.hasAttribute("data-reject")), true);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(
    await evaluate(
      () =>
        matchMedia("(prefers-reduced-motion: reduce)").matches &&
        getComputedStyle(document.querySelector("button")).transitionDuration === "0s"
    ),
    true
  );
  await evaluate(() => {
    document.querySelector('a[data-nav="dispatch"]').click();
    document.querySelector('[name="title"]').value = "Browser-created fixture";
    document.querySelector('[name="intent"]').value = "Validate local creation feedback";
    document.querySelector('#task-form button[type="submit"]').click();
  });
  await waitFor(() => document.querySelector("#task-result")?.textContent.startsWith("Created "));
  assert.equal(await evaluate(() => document.querySelector('[name="title"]').value), "Browser-created fixture");
  assert.equal(await evaluate(() => window.location.hash), "#dispatch");
  // Exercise real browser offline/reconnection, preserving the composer draft.
  await send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0
  });
  await evaluate(() => window.dispatchEvent(new Event("offline")));
  await waitFor(() => [...document.querySelectorAll("[data-approve]")].every((button) => button.disabled));
  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  });
  await evaluate(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => typeof snapshotCurrent !== "undefined" && snapshotCurrent);
  assert.equal(await evaluate(() => document.querySelector('[name="title"]').value), "Browser-created fixture");
  if (runtimeErrors.length) failures.push({ runtimeErrors });
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(
      {
        results,
        failures,
        behavioralChecks: [
          "authenticated gateway",
          "modal keyboard containment",
          "focus restoration",
          "reduced motion",
          "real creation",
          "draft preservation",
          "offline reconciliation"
        ]
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ viewsChecked: results.length, evidence, failures }, null, 2));
  assert.equal(failures.length, 0, "browser and accessibility checks");
} finally {
  await writeFile(join(evidence, "report.json"), JSON.stringify({ results, failures, runtimeErrors }, null, 2));
  console.log(JSON.stringify({ evidence, viewsChecked: results.length, failureCount: failures.length }));
  if (ws) ws.close();
  if (chrome && chrome.exitCode === null) {
    const closed = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await closed;
  }
  await app.close();
  await rm(join(scratch, "chrome"), { recursive: true, force: true });
  // Evidence is retained; only this invocation's disposable database is removed.
  for (const suffix of ["", "-wal", "-shm"]) await rm(dbPath + suffix, { force: true });
}
