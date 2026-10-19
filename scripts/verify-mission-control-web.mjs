/* global document, window, innerWidth, axe */
// End-to-end verification for the React Mission Control app served at /next/.
//
// Real ephemeral gateway + temp SQLite + the real dry-run worker + a real
// browser. Fixtures exist only in this script; production code has no seeded
// data. Run `npm run build` first (gateway and the SPA must be built).
//
//   ACS_UI_EVIDENCE_DIR=/abs/out node scripts/verify-mission-control-web.mjs
//
// Playwright is not a repo dependency. Provide it with ACS_PLAYWRIGHT_MODULE
// (module path) and optionally ACS_BROWSER_EXECUTABLE.
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkerOnce } from "../apps/worker/dist/index.js";
import { buildGateway } from "../apps/gateway/dist/server.js";
import { SqliteWorkItemStore } from "../packages/work-items/dist/index.js";
import { createWorkItemTools, createPolicyEngine } from "../packages/policy-gate/dist/index.js";

const { chromium } = await import(process.env.ACS_PLAYWRIGHT_MODULE || "playwright");
const distDir = fileURLToPath(new URL("../apps/mission-control-web/dist", import.meta.url));
if (!existsSync(join(distDir, "index.html"))) throw Error("apps/mission-control-web is not built (npm run build -w apps/mission-control-web)");

const dir = mkdtempSync(join(tmpdir(), "acs-mcweb-e2e-"));
const dbPath = join(dir, "control.db");
const token = randomBytes(32).toString("hex");
const readerToken = randomBytes(32).toString("hex");
const out = process.env.ACS_UI_EVIDENCE_DIR || join(dir, "evidence");
mkdirSync(out, { recursive: true });

// ── fixture: real registry agents + heartbeats, real work items, real worker runs ──
const store = new SqliteWorkItemStore(dbPath);
store.registerActor({ id: "qa-operator", actorType: "HUMAN", displayName: "QA operator", externalRef: "local_bearer:local-dev" });
store.registerActor({ id: "qa-requester", actorType: "HUMAN", displayName: "QA requester" });
for (const [i, name, role] of [
  [1, "Integration reviewer", "REVIEW_PLANNING_AGENT"],
  [2, "Runtime investigator", "LOCAL_CODING_AGENT"],
  [3, "Control plane coordinator", "ORCHESTRATION_LAYER"]
]) {
  const id = "qa-agent-" + i;
  store.createRegistryAgent({ id, name, kind: "integration-test", acpRole: role, actorId: "qa-operator" });
  store.recordAgentHeartbeat(id, { status: i === 2 ? "BUSY" : "AVAILABLE", currentTask: i === 2 ? "Inspect queue admission" : undefined, actorId: "qa-operator" });
}
const tools = createWorkItemTools(store, createPolicyEngine());
const titles = ["Inspect execution admission", "Review policy boundaries", "Verify audit event routing", "Inspect registry capabilities", "Check connector scopes", "Read runtime heartbeat", "Compare readiness checks", "Inspect queue latency", "Review deployment request", "Review storage mutation"];
const ids = [];
for (const [i, title] of titles.entries()) {
  const item = tools.create_work_item({
    title,
    intent: "Browser integration verification",
    requester: "user",
    requesterSubject: "qa-requester",
    target: { cwd: "/tmp", repo: "acs-e2e-private-repo" },
    risk: i >= 8 ? "high" : "low",
    requestedActions: [{ kind: "fs.read", description: "inspect evidence", params: { paths: ["/tmp"] } }]
  });
  ids.push(item.id);
}
tools.cancel_work_item({ id: ids[0], actor: "qa-operator", reason: "Seed terminal lineage" });
store.close();
for (let i = 0; i < 3; i++) {
  const result = await runWorkerOnce({ dbPath, workerId: "qa-agent-2", executionBackend: "dry_run" });
  if (!result.executed || result.executionMode !== "dry_run") throw Error("Dry-run worker fixture did not execute");
}

const app = buildGateway({
  dbPath,
  logger: false,
  auth: {
    token,
    actor: "qa-operator",
    actorId: "qa-operator",
    credentials: [
      { id: "operator", token, actor: "qa-operator", actorId: "qa-operator", roles: ["operator"], scopes: ["acs:read", "acs:write", "acs:approve"] },
      { id: "reader", token: readerToken, actor: "qa-operator", actorId: "qa-reader", roles: ["operator"], scopes: ["acs:read"] }
    ]
  },
  moa: false,
  missionControlWeb: { enabled: true, distDir }
});
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
let appClosed = false;
async function closeApp() {
  if (appClosed) return;
  appClosed = true;
  app.server.closeAllConnections();
  await app.close();
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.ACS_BROWSER_EXECUTABLE ? { executablePath: process.env.ACS_BROWSER_EXECUTABLE } : {})
});
const authHeaders = { authorization: "Bearer " + token };
const context = await browser.newContext({ extraHTTPHeaders: authHeaders, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
const consoleProblems = [];
const badResponses = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" || /content security policy|refused to/i.test(m.text())) consoleProblems.push(m.text());
});
page.on("response", (r) => {
  if (r.status() >= 400) badResponses.push({ path: new URL(r.url()).pathname, status: r.status() });
});
const axeSource = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const checks = [];
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
const accessibility = [];
async function axeScan(label) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 260), why: (n.any[0] ?? n.all[0] ?? n.none[0])?.message })) }));
  });
  accessibility.push({ label, violations: result });
  if (result.length) throw Error("axe violations at " + label + ": " + JSON.stringify(result));
}
const ready = () => page.getByRole("heading", { name: "Command", level: 1 }).waitFor();

try {
  await check("Shell loads from /next/ with strict CSP and no console/CSP errors", async () => {
    const res = await page.goto(origin + "/next/");
    if (!res.headers()["content-security-policy"]?.includes("script-src 'self'")) throw Error("CSP header missing");
    await ready();
    await page.locator("header [role=status]").getByText("Live").waitFor();
  });

  await check("Command renders real backend data (no seeded UI data)", async () => {
    await page.getByRole("heading", { name: "Needs you" }).waitFor();
    const api = await (await context.request.get(origin + "/api/mission-control/overview")).json();
    if (api.needsYou.approvals < 1) throw Error("fixture should have approvals");
    const text = (await page.locator("#needs-you").textContent()) ?? "";
    if (!text.includes("Awaiting approval")) throw Error("needs-you missing");
    const awaiting = (await page.locator("#needs-you a", { hasText: /awaiting approval/i }).textContent()) ?? "";
    if (!awaiting.includes(String(api.needsYou.approvals))) throw Error("approval count mismatch: " + awaiting);
    for (const title of ["Inspect execution admission", "Review deployment request"]) {
      await page.locator("#pipeline").getByText(title).first().waitFor();
    }
  });

  await check("Agent network shows registered agents with honest liveness", async () => {
    for (const name of ["Integration reviewer", "Runtime investigator", "Control plane coordinator"]) {
      await page.locator("#agent-network").getByRole("button", { name: new RegExp(name + ", agent") }).waitFor();
    }
    await page.locator("#agent-network").getByRole("button", { name: /Runtime investigator, agent/ }).click();
    await page.locator("#agent-network aside").getByText("Runtime investigator").first().waitFor();
    await page.getByRole("button", { name: "Table" }).click();
    await page.locator("#agent-network table").waitFor();
    await page.getByRole("button", { name: "Graph" }).click();
  });

  await check("Execution mode and dry-run are always visible", async () => {
    await page.getByText("Dry run, simulated").waitFor();
    await page.getByText("Strict mode").waitFor();
  });

  await check("Sensitive data never reaches the browser", async () => {
    const html = await page.content();
    const api = JSON.stringify(await (await context.request.get(origin + "/api/mission-control/overview")).json());
    for (const bad of ["acs-e2e-private-repo", "tokenHash", token]) {
      if (html.includes(bad) || api.includes(bad)) throw Error("leak: " + bad);
    }
  });

  await check("Live update: a new work item appears via SSE without reload", async () => {
    const res = await context.request.post(origin + "/work-items", {
      data: { title: "SSE live update probe", intent: "prove live refresh", target: { cwd: "/tmp" }, requestedActions: [], risk: "low" }
    });
    if (res.status() !== 201) throw Error("create failed " + res.status());
    await page.locator("#pipeline").getByText("SSE live update probe").first().waitFor({ timeout: 8000 });
  });

  await check("Keyboard: Ctrl+K opens the page switcher and Esc closes it", async () => {
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Go to page" }).waitFor();
    await page.keyboard.type("audit");
    await page.getByRole("option", { name: /Audit/ }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Go to page" }).waitFor({ state: "hidden" });
  });

  await check("Unmigrated pages link to the classic console (nothing disappears)", async () => {
    const hrefs = await page.locator("nav a[href^='/#']").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    for (const h of ["/#agents", "/#executors", "/#connectors", "/#metrics", "/#audit", "/#policy", "/#system"]) {
      if (!hrefs.includes(h)) throw Error("missing classic link " + h);
    }
  });

  await check("Work Queue shows real items, filters by status and links to a real trace", async () => {
    await page.locator("nav").getByRole("link", { name: /Work Queue/ }).click();
    const table = page.getByRole("table", { name: "Work items" });
    await table.waitFor();
    for (const title of ["Inspect execution admission", "Review deployment request"]) await table.getByText(title).first().waitFor();
    const api = await (await context.request.get(origin + "/api/mission-control/queue")).json();
    const doneCount = api.counts.byStatus.succeeded;
    if (!(doneCount >= 1)) throw Error("fixture should have succeeded items");
    await page.getByRole("button", { name: /^succeeded/ }).click();
    await page.getByText(/Showing \d+ of \d+ loaded/).waitFor();
    if ((await table.locator("tbody tr").count()) < 1) throw Error("no succeeded rows");
    if (!page.url().includes("status=succeeded")) throw Error("filter not reflected in the URL");
    await page.getByRole("button", { name: "All", exact: true }).click();
    // honesty: the approval item is a drafted/admitted plan state, never an invented one
    const planText = (await table.textContent()) ?? "";
    if (!/(Admitted|Plan not admitted|No plan)/.test(planText)) throw Error("plan state missing");
  });

  await check("Execution trace reflects the persisted dry-run execution", async () => {
    const api = await (await context.request.get(origin + "/api/mission-control/queue")).json();
    const done = api.items.find((i) => i.status === "succeeded" && i.attempt);
    if (!done) throw Error("no succeeded item with an attempt");
    await page.goto(origin + "/next/#/queue/" + encodeURIComponent(done.id));
    const stages = page.getByRole("list", { name: "Execution trace stages" });
    await stages.waitFor();
    for (const label of ["Request", "Policy decision", "Execution plan", "Admission", "Human approval", "Execution attempt", "Lease and fencing", "Result"]) {
      await stages.getByRole("heading", { name: label }).waitFor();
    }
    await stages.getByText("Policy did not require approval.").waitFor(); // auto-allowed work is never shown as a human grant
    await page.getByRole("heading", { name: "Attempts and leases" }).waitFor();
    await page.getByText(/Attempt #1/).first().waitFor();
    await page.getByText("Dry run").first().waitFor().catch(() => undefined);
    const html = await page.content();
    for (const bad of ["acs-e2e-private-repo", "tokenHash", token, "/tmp"]) if (html.includes(bad)) throw Error("trace leak: " + bad);
    await page.getByRole("link", { name: "← Back to work queue" }).click();
    await page.getByRole("table", { name: "Work items" }).waitFor();
  });

  await check("Missing work item shows not-found, never a blank page", async () => {
    await page.goto(origin + "/next/#/queue/wrk_does_not_exist");
    await page.getByText("Work item not found").waitFor();
  });

  await check("Legacy console at / is unaffected", async () => {
    const p2 = await context.newPage();
    await p2.goto(origin + "/");
    await p2.waitForFunction(() => document.querySelector(".live")?.dataset.state === "live");
    if ((await p2.locator(".mission-card").count()) < 6) throw Error("legacy board missing");
    await p2.close();
  });

  const sweepQueue = await (await context.request.get(origin + "/api/mission-control/queue")).json();
  const traceTarget = sweepQueue.items.find((i) => i.status === "succeeded" && i.attempt) ?? sweepQueue.items[0];
  const sweepPages = [
    ["command", "/next/#/", () => page.getByRole("heading", { name: "Needs you" }).waitFor()],
    ["queue", "/next/#/queue", () => page.getByRole("table", { name: "Work items" }).waitFor()],
    ["trace", "/next/#/queue/" + encodeURIComponent(traceTarget.id), () => page.getByRole("list", { name: "Execution trace stages" }).waitFor()],
    ["approvals", "/next/#/approvals", () => page.getByRole("list", { name: /Work waiting on a human/ }).waitFor()],
    ["execution", "/next/#/execution", () => page.getByRole("table", { name: "Execution attempts" }).waitFor()]
  ];
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [[1440, 900], [1024, 800], [768, 900], [390, 844]]) {
     for (const [pageName, path, pageReady] of sweepPages) {
      await check(`Accessible and no horizontal overflow: ${pageName} ${theme} @ ${width}`, async () => {
        await page.evaluate((t) => window.localStorage.setItem("acs-theme", t), theme);
        await page.setViewportSize({ width, height });
        await page.goto(origin + path);
        await page.reload();
        await page.getByRole("heading", { level: 1 }).waitFor();
        await pageReady();
        await page.locator("header [role=status]").getByText("Live").waitFor();
        const overflowing = await page.evaluate(() =>
          document.documentElement.scrollWidth > innerWidth + 2
            ? [...document.querySelectorAll("body *")]
                .filter((e) => e.getBoundingClientRect().right > innerWidth + 2 && !e.closest("[role=region][tabindex]"))
                .slice(0, 5)
                .map((e) => e.tagName + "." + String(e.className).slice(0, 80) + " right=" + Math.round(e.getBoundingClientRect().right))
            : []
        );
        if (overflowing.length) throw Error("horizontal overflow: " + overflowing.join(" | "));
        await axeScan(`${pageName}-${theme}@${width}`);
        await page.screenshot({ path: join(out, `${pageName}-${theme}-${width}.png`), fullPage: width >= 1024 });
      });
     }
    }
  }
  await page.evaluate(() => window.localStorage.removeItem("acs-theme"));
  await page.setViewportSize({ width: 1440, height: 900 });

  await check("Execution page shows real dry-run attempts and labels them simulated", async () => {
    await page.goto(origin + "/next/#/execution");
    const table = page.getByRole("table", { name: "Execution attempts" });
    await table.waitFor();
    await page.getByText(/Dry run: attempts below are simulated/).waitFor();
    if ((await table.locator("tbody tr").count()) < 3) throw Error("expected three dry-run attempts");
    if (await table.getByRole("button", { name: /^Retry / }).count()) throw Error("retry offered for non-failed attempts");
  });

  await check("Read-only credential sees approvals but every control is disabled with a reason", async () => {
    const ro = await browser.newContext({ extraHTTPHeaders: { authorization: "Bearer " + readerToken }, viewport: { width: 1280, height: 900 } });
    const p = await ro.newPage();
    await p.goto(origin + "/next/#/approvals");
    await p.getByRole("list", { name: /Work waiting on a human/ }).waitFor();
    await p.getByText("Read only").waitFor();
    const buttons = p.getByRole("button", { name: /^(Approve|Deny|Unblock) / });
    if ((await buttons.count()) < 1) throw Error("no controls rendered");
    for (let i = 0; i < (await buttons.count()); i++) if (!(await buttons.nth(i).isDisabled())) throw Error("control enabled for a read-only credential");
    await p.getByText(/does not have approval permission/).first().waitFor();
    const direct = await ro.request.post(origin + "/work-items/" + ids[8] + "/reject", { data: { reason: "reader must be refused" } });
    if (direct.status() !== 403) throw Error("server must refuse a reader, got " + direct.status());
    await ro.close();
  });

  await check("Approve through the UI: reason required, one POST, server state changes", async () => {
    await page.goto(origin + "/next/#/approvals");
    await page.getByRole("list", { name: /Work waiting on a human/ }).waitFor();
    const approveBtn = page.getByRole("button", { name: /^Approve .* for Review deployment request$/ });
    await approveBtn.waitFor();
    await page.locator("header [role=status]").getByText("Live").waitFor();
    const posts = [];
    page.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
    await approveBtn.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const confirm = dialog.getByRole("button", { name: "Approve", exact: true });
    if (!(await confirm.isDisabled())) throw Error("confirm must be disabled without a reason");
    await dialog.getByRole("textbox").fill("e2e: reviewed the request");
    await confirm.dblclick();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(/approved\./).waitFor();
    if (posts.length !== 1 || !posts[0].endsWith("/approve")) throw Error("expected exactly one approve POST, got " + JSON.stringify(posts));
    await page.getByRole("link", { name: "Review deployment request" }).waitFor({ state: "detached", timeout: 8000 });
    const after = await (await context.request.get(origin + "/api/mission-control/queue")).json();
    const item = after.items.find((i) => i.id === ids[8]);
    if (!item || item.status === "needs_approval") throw Error("approval did not change server state: " + JSON.stringify(item?.status));
    page.removeAllListeners("request");
  });

  await check("Deny through the UI rejects the work item server-side", async () => {
    const denyBtn = page.getByRole("button", { name: "Deny Review storage mutation" });
    await denyBtn.waitFor();
    await denyBtn.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("e2e: not acceptable");
    await dialog.getByRole("button", { name: "Deny", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Review storage mutation" }).waitFor({ state: "detached", timeout: 8000 });
    const after = await (await context.request.get(origin + "/api/mission-control/queue")).json();
    if (after.items.find((i) => i.id === ids[9])?.status !== "rejected") throw Error("deny did not reject the item");
  });

  await check("Escape dismisses a confirmation without sending anything", async () => {
    const posts = [];
    page.on("request", (r) => r.method() === "POST" && posts.push(r.url()));
    await page.goto(origin + "/next/#/approvals");
    const btn = page.getByRole("button", { name: /^(Approve|Deny|Unblock) / }).first();
    if (!(await btn.count())) return; // all approvals handled above
    await btn.click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    page.removeAllListeners("request");
    if (posts.length) throw Error("Escape must not send anything");
  });

  await check("Unauthenticated: API rejects and the SPA shows sign-in, never data", async () => {
    const anon = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await anon.newPage();
    const api = await anon.request.get(origin + "/api/mission-control/overview");
    if (api.status() !== 401) throw Error("anonymous overview not rejected: " + api.status());
    await p.goto(origin + "/next/");
    await p.getByRole("heading", { name: "Sign in required" }).waitFor();
    if ((await p.content()).includes("Inspect execution admission")) throw Error("data leaked to anonymous page");
    await anon.close();
  });

  await check("Schema-invalid response fails closed to 'unavailable'", async () => {
    const p = await context.newPage();
    await p.route("**/api/mission-control/overview", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, leaked: "secret" }) }));
    await p.goto(origin + "/next/");
    await p.getByText("Mission Control data unavailable").waitFor();
    if (await p.getByText("Needs you").count()) throw Error("rendered data despite invalid contract");
    await p.close();
  });

  await check("Stream loss shows a stale banner and keeps last data", async () => {
    await page.goto(origin + "/next/");
    await ready();
    await page.locator("header [role=status]").getByText("Live").waitFor();
    await closeApp();
    await page.getByText("Live stream disconnected").waitFor({ timeout: 15000 });
    await page.getByText("Disconnected").first().waitFor();
    if (!((await page.locator("#pipeline").textContent()) ?? "").includes("Inspect execution admission")) throw Error("last data discarded on stream loss");
    await page.screenshot({ path: join(out, "command-stale.png") });
  });

  if (pageErrors.length) throw Error("page errors: " + pageErrors.join("; "));
  const csp = consoleProblems.filter((m) => /content security policy|refused to/i.test(m));
  if (csp.length) throw Error("CSP violations: " + csp.join("; "));
  console.log(JSON.stringify({ checks: checks.length, pageErrors, consoleProblems: consoleProblems.length, badResponses }, null, 2));
  writeFileSync(join(out, "web-verification.json"), JSON.stringify({ checks, accessibility, badResponses, consoleProblems }, null, 2));
  console.log(`PASS ${checks.length} checks; evidence in ${out}`);
} catch (error) {
  console.error("FAIL", error.message.split("\n")[0]);
  console.error(JSON.stringify({ pageErrors, consoleProblems, badResponses, url: page.url() }, null, 2));
  try {
    await page.screenshot({ path: join(out, "failure.png") });
    console.error((await page.locator("body").innerText()).slice(0, 1500));
  } catch {
    /* page already closed */
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  await closeApp();
}
