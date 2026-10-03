/* global document, innerWidth, axe */
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkerOnce } from "../apps/worker/dist/index.js";
import { buildGateway } from "../apps/gateway/dist/server.js";
import { SqliteWorkItemStore } from "../packages/work-items/dist/index.js";
import { createWorkItemTools, createPolicyEngine } from "../packages/policy-gate/dist/index.js";
const { chromium } = await import(process.env.ACS_PLAYWRIGHT_MODULE || "playwright");
const dir = mkdtempSync(join(tmpdir(), "acs-redesign-browser-"));
const dbPath = join(dir, "control.db");
const token = randomBytes(32).toString("hex");
const store = new SqliteWorkItemStore(dbPath);
store.registerActor({
  id: "qa-operator",
  actorType: "HUMAN",
  displayName: "QA operator",
  externalRef: "local_bearer:local-dev"
});
store.registerActor({ id: "qa-requester", actorType: "HUMAN", displayName: "QA requester" });
for (const [i, name, role] of [
  [1, "Integration reviewer", "REVIEW_PLANNING_AGENT"],
  [2, "Runtime investigator", "LOCAL_CODING_AGENT"],
  [3, "Control plane coordinator", "ORCHESTRATION_LAYER"]
]) {
  const id = "qa-agent-" + i;
  store.createRegistryAgent({ id, name, kind: "integration-test", acpRole: role, actorId: "qa-operator" });
  store.recordAgentHeartbeat(id, {
    status: i === 2 ? "BUSY" : "AVAILABLE",
    currentTask: i === 2 ? "Inspect queue admission" : undefined,
    actorId: "qa-operator"
  });
}
const { publicKey } = generateKeyPairSync("ed25519");
store.registerConnector({
  id: "qa-connector",
  displayName: "QA audit integration",
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  allowedScopes: ["acs:work:read"],
  actorId: "qa-operator"
});
const tools = createWorkItemTools(store, createPolicyEngine());
const titles = [
  "Inspect execution admission",
  "Review policy boundaries",
  "Verify audit event routing",
  "Inspect registry capabilities",
  "Check connector scopes",
  "Read runtime heartbeat",
  "Compare readiness checks",
  "Inspect queue latency",
  "Review deployment request",
  "Review storage mutation"
];
const ids = [];
for (const [i, title] of titles.entries()) {
  const item = tools.create_work_item({
    title,
    intent: "Browser integration verification",
    requester: "user",
    requesterSubject: "qa-requester",
    target: { cwd: "/tmp" },
    risk: i >= 8 ? "high" : "low",
    requestedActions: [{ kind: "fs.read", description: "inspect evidence", params: { paths: ["/tmp"] } }]
  });
  ids.push(item.id);
}
const cancelled = tools.cancel_work_item({
  id: ids[0],
  actor: "qa-operator",
  reason: "Seed terminal lineage for browser retry test"
});
store.close();
for (let i = 0; i < 3; i++) {
  const result = await runWorkerOnce({ dbPath, workerId: "qa-agent-2", executionBackend: "dry_run" });
  if (!result.executed || result.executionMode !== "dry_run") throw Error("Dry-run worker fixture did not execute");
}
const app = buildGateway({
  dbPath,
  logger: false,
  auth: { token, actor: "qa-operator", actorId: "qa-operator" },
  moa: false
});
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
// The stream-loss check shuts the gateway down mid-run to prove the browser marks
// data stale, and the finally block also closes it. Closing a Fastify instance twice
// throws, so track the shutdown and make it idempotent.
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
const context = await browser.newContext({
  extraHTTPHeaders: { authorization: "Bearer " + token },
  viewport: { width: 1586, height: 1000 }
});
const page = await context.newPage();
const errors = [],
  network = [],
  checks = [],
  accessibility = [];
const axeSource = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400) network.push({ path: new URL(response.url()).pathname, status: response.status() });
});
const out = process.env.ACS_UI_EVIDENCE_DIR || join(dir, "evidence");
mkdirSync(out, { recursive: true });
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log("PASS " + name);
}
try {
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector(".live")?.dataset.state === "live");
  await check("Overview persisted work-item board", async () => {
    if ((await page.locator(".mission-card").count()) < 6) throw Error("missing board items");
  });
  await page.screenshot({ path: join(out, "mission-control-overview.png"), fullPage: true });
  for (const view of [
    "overview",
    "queue",
    "execution",
    "approvals",
    "agents",
    "executors",
    "connectors",
    "metrics",
    "audit",
    "policy",
    "system"
  ]) {
    await check("Direct URL and refresh: " + view, async () => {
      await page.goto(origin + "/#" + view);
      await page.waitForFunction((v) => document.body.dataset.activeView === v, view);
      await page.reload();
      await page.waitForFunction((v) => document.body.dataset.activeView === v, view);
      if (!(await page.locator('[data-nav="' + view + '"]').getAttribute("aria-current")))
        throw Error("no active navigation");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
      if (overflow) throw Error("desktop overflow " + view);
    });
  }
  for (const view of [
    "overview",
    "queue",
    "execution",
    "approvals",
    "agents",
    "executors",
    "connectors",
    "metrics",
    "audit",
    "policy",
    "system"
  ]) {
    await page.goto(origin + "/#" + view);
    await page.evaluate(axeSource);
    const result = await page.evaluate(
      async () => await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } })
    );
    const violations = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    accessibility.push({
      view,
      violations: violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) }))
    });
  }
  writeFileSync(join(out, "accessibility-verification.json"), JSON.stringify(accessibility, null, 2));
  if (accessibility.some((r) => r.violations.length))
    throw Error("Accessibility violations: " + JSON.stringify(accessibility.filter((r) => r.violations.length)));
  checks.push("Eleven views: WCAG axe including color contrast");
  await page.goto(origin + "/#execution");
  await page.screenshot({ path: join(out, "mission-control-execution.png"), fullPage: true });
  await check("Persisted worker outcomes populate real throughput chart", async () => {
    if ((await page.locator("#execution-operations .chart-wrap svg rect").count()) === 0)
      throw Error("No chart from actual worker outcomes");
    if (!(await page.locator("#execution-operations").textContent()).includes("DRY RUN"))
      throw Error("Simulation mode not labelled");
  });
  await check("Execution row opens actual detail drawer", async () => {
    await page
      .locator('#execution-operations [data-inspect-work="' + ids[1] + '"]')
      .first()
      .click();
    await page.locator("#work-detail h3").filter({ hasText: titles[1] }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#work-drawer").waitFor({ state: "hidden" });
  });
  await check("Agent details use actual registry API", async () => {
    await page.goto(origin + "/#agents");
    await page.locator('#agent-roster-body [data-agent="qa-agent-1"]').click();
    await page.locator("#agent-detail").getByText("Integration reviewer", { exact: true }).waitFor();
  });
  await check("Executor details use actual executor contract", async () => {
    await page.goto(origin + "/#executors");
    await page.locator("[data-executor]").first().waitFor();
    await page.locator("[data-executor]").first().click();
    await page.waitForFunction(() => document.querySelector("#executor-detail")?.textContent.includes("Capabilities"));
  });
  await check("Connector detail uses registry and scope projection", async () => {
    await page.goto(origin + "/#connectors");
    await page.locator('[data-connector="qa-connector"]').waitFor();
    await page.locator('[data-connector="qa-connector"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#connector-detail")?.textContent.includes("acs:work:read")
    );
  });
  await check("Approval grant, audit, and resulting refresh", async () => {
    await page.goto(origin + "/#approvals");
    await page.waitForFunction(() => document.querySelector(".live")?.dataset.state === "live");
    await page.locator('[data-reason="' + ids[8] + '"]').fill("Browser verified independent human review");
    await page
      .locator('[data-approve="' + ids[8] + '"]')
      .first()
      .click();
    await page.locator("#approval-confirm-dialog").waitFor();
    await page.locator("#approval-confirm-dialog button").last().click();
    await page.waitForFunction((id) => !document.querySelector('[data-approve="' + id + '"]'), ids[8]);
    const res = await context.request.get(origin + "/work-items/" + ids[8]);
    if ((await res.json()).workItem.status !== "approved") throw Error("grant not persisted");
  });
  await check("Reject action and backend refresh", async () => {
    await page.locator('[data-reason="' + ids[9] + '"]').fill("Browser verified request rejection");
    await page.locator('[data-reject="' + ids[9] + '"]').click();
    await page.locator("#approval-confirm-dialog").waitFor();
    await page.locator("#approval-confirm-dialog button").last().click();
    await page.waitForFunction((id) => !document.querySelector('[data-reject="' + id + '"]'), ids[9]);
    const res = await context.request.get(origin + "/work-items/" + ids[9]);
    if ((await res.json()).workItem.status !== "rejected") throw Error("reject not persisted");
  });
  await check("Retry creates new authoritative lineage", async () => {
    await page.goto(origin + "/?item=" + cancelled.id + "#queue");
    await page.waitForFunction(() => document.querySelector(".live")?.dataset.state === "live");
    await page.locator("#work-detail [data-control-reason]").fill("Browser verified retry lineage");
    await page.locator('#work-detail [data-work-control="retry"]').click();
    await page.locator("#action-status").filter({ hasText: "retry created" }).waitFor();
    const res = await context.request.get(origin + "/work-items");
    const rows = (await res.json()).workItems;
    if (!rows.some((r) => r.sourceWorkItemId === cancelled.id && r.lineageType === "retry"))
      throw Error("retry lineage missing");
    await page.keyboard.press("Escape");
  });
  await check("Audit inspection uses immutable sanitized metadata", async () => {
    await page.goto(origin + "/#audit");
    await page.locator("[data-inspect-audit]").first().click();
    await page.locator("#audit-drawer").waitFor({ state: "visible" });
    if (!(await page.locator("#audit-detail").textContent()).includes("immutable event"))
      throw Error("missing audit detail");
    await page.keyboard.press("Escape");
    await page.locator("#audit-drawer").waitFor({ state: "hidden" });
  });
  await check("System readiness checks real response", async () => {
    await page.goto(origin + "/#system");
    await page.waitForFunction(() => document.querySelector("#system-probes")?.textContent.includes("Last checked"));
  });
  await check("Backend mode mutation reflected globally", async () => {
    await page.locator('input[name="executionMode"][value="admin"]').check();
    await page.locator("#execution-mode-result").filter({ hasText: "mode admin" }).waitFor();
    const res = await context.request.get(origin + "/dashboard/fragments");
    if ((await res.json()).fragments.executionModeState !== "admin") throw Error("mode not persisted");
    await page.locator('input[name="executionMode"][value="strict"]').check();
    await page.locator("#execution-mode-result").filter({ hasText: "mode strict" }).waitFor();
  });
  await check("Read and mutation authentication fail closed", async () => {
    const read = await app.inject({ method: "GET", url: "/dashboard/fragments" });
    if (read.statusCode !== 401) throw Error("unauthorized read admitted");
    const mutate = await app.inject({
      method: "POST",
      url: "/work-items/" + ids[1] + "/cancel",
      payload: { reason: "unauthorized test" }
    });
    if (mutate.statusCode !== 401) throw Error("unauthorized mutation admitted");
  });
  for (const width of [1586, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of [
      "overview",
      "queue",
      "execution",
      "approvals",
      "agents",
      "executors",
      "connectors",
      "metrics",
      "audit",
      "policy",
      "system"
    ]) {
      await page.goto(origin + "/#" + view);
      await page.waitForFunction((v) => document.body.dataset.activeView === v, view);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
      if (overflow) throw Error("overflow " + width + " " + view);
    }
    checks.push("Responsive eleven views at " + width);
  }
  await page.goto(origin + "/#overview");
  await page.screenshot({ path: join(out, "mission-control-mobile.png"), fullPage: true });
  await check("Stream loss marks data stale and disables mutations", async () => {
    await closeApp();
    await page.waitForFunction(() => document.querySelector(".live")?.dataset.state === "disconnected");
    if (await page.locator("#sse-stale-banner").isHidden())
      throw Error("No stale-state warning after gateway shutdown");
    if (
      await page
        .locator("[data-approve]:not([disabled]),[data-reject]:not([disabled]),[data-unblock]:not([disabled])")
        .count()
    )
      throw Error("Stale mutations left enabled");
  });
  if (errors.length || network.length) throw Error(JSON.stringify({ errors, network }));
  writeFileSync(
    join(out, "browser-verification.json"),
    JSON.stringify(
      {
        checks,
        errors,
        network,
        fixture: "Isolated authenticated ACS gateway and temporary persisted SQLite database",
        date: new Date().toISOString()
      },
      null,
      2
    )
  );
  console.log("BROWSER_PASS " + checks.length + " checks; evidence: " + out);
} finally {
  await browser.close();
  await closeApp();
}
