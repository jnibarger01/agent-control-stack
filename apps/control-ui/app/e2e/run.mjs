// Mission Control end-to-end run against a REAL, disposable ACS gateway.
//
//   npm run build && node apps/control-ui/app/e2e/run.mjs
//
// It never touches a running gateway: it creates a temp database and a random
// token, boots apps/gateway/dist/cli.js on a loopback port, seeds governed work
// through the public API, drives the built SPA in headless Chrome and asserts
// on both the UI and the authoritative backend state.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchBrowser } from "./cdp.mjs";

const root = resolve(import.meta.dirname, "../../../..");
const port = Number(process.env.ACS_E2E_PORT ?? 3718);
const base = `http://127.0.0.1:${port}`;
const token = randomBytes(24).toString("hex");
const work = mkdtempSync(join(tmpdir(), "acs-console-e2e-"));
const shots = process.env.ACS_E2E_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

// --- boot gateway ----------------------------------------------------------------
const { SqliteWorkItemStore } = await import(resolve(root, "packages/work-items/dist/index.js"));
const dbPath = join(work, "e2e.db");
const store = new SqliteWorkItemStore(dbPath);
store.registerActor({ id: "operator-e2e", actorType: "HUMAN", displayName: "E2E Operator" });
// Exercise the existing policy/worker claim boundary in this disposable store.
// No engine executes and no production database is accessed.
const { createWorkItemTools, createPolicyEngine } = await import(resolve(root, "packages/policy-gate/dist/index.js"));
const fixtureTools = createWorkItemTools(store, createPolicyEngine());
const executing = fixtureTools.create_work_item({
  title: "E2E inspect workspace",
  requester: "user",
  intent: "Read the workspace manifest",
  target: { cwd: "/tmp" },
  risk: "low",
  requestedActions: [{ kind: "fs.read", description: "Read manifest", params: { paths: ["/tmp/manifest.json"] } }]
});
const claimed = fixtureTools.claim_next_approved_work_item({ workerId: "worker-e2e", leaseMs: 600000 });
check(
  "execution fixture passes policy and receives a worker lease",
  claimed?.id === executing.id && claimed?.status === "running"
);
store.close();
const gateway = spawn("node", [resolve(root, "apps/gateway/dist/cli.js")], {
  env: {
    PATH: process.env.PATH,
    ACS_DB_PATH: dbPath,
    ACS_GATEWAY_TOKEN: token,
    ACS_GATEWAY_ACTOR: "user",
    ACS_GATEWAY_ACTOR_ID: "operator-e2e",
    PORT: String(port),
    HOST: "127.0.0.1"
  },
  stdio: "ignore"
});
let browser;
let page;
try {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/livez`)).ok) break;
    } catch {
      await sleep(100);
    }
  }

  // --- seed real governed work ---------------------------------------------------
  const mk = (title, risk, kind, params) =>
    api("/work-items", {
      method: "POST",
      body: {
        title,
        intent: `${title} (e2e)`,
        risk,
        target: { cwd: "/tmp" },
        requestedActions: [{ kind, description: `${kind} for ${title}`, params }]
      }
    });
  const approveMe = (await mk("E2E approve me", "high", "fs.write", { path: "a.txt", content: "x" })).body;
  const rejectMe = (await mk("E2E reject me", "high", "fs.write", { path: "b.txt", content: "y" })).body;
  const blocked = (await mk("E2E blocked item", "low", "read_file", { path: "README.md" })).body;
  const xss = (
    await mk('<img src=x onerror="window.__xss=1"> payload', "high", "fs.write", { path: "c.txt", content: "z" })
  ).body;
  await api("/api/agents", {
    method: "POST",
    body: { id: "analyst-1", name: "Analyst 1", kind: "llm", acpRole: "LOCAL_CODING_AGENT" }
  });
  await api("/api/agents/analyst-1/heartbeat", { method: "POST", body: { status: "AVAILABLE" } });
  await api("/api/agents/analyst-1/capabilities", {
    method: "PUT",
    body: { capabilities: [{ name: "code.review", description: "Review diffs" }] }
  });
  await api("/api/agents", {
    method: "POST",
    body: { id: "quiet-2", name: "Quiet 2", kind: "llm", acpRole: "IMPLEMENTATION_AGENT" }
  });
  const { generateKeyPairSync } = await import("node:crypto");
  const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  await api("/connectors", {
    method: "POST",
    body: { id: "corp-dc-1", displayName: "Corp DC 1", publicKeyPem: pem, allowedScopes: ["acs:work:read"] }
  });
  await api("/connectors/corp-dc-1/tunnel-sessions", {
    method: "POST",
    body: { tunnelId: "tun-1", sessionId: "sess-1", expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString() }
  });
  await api("/connectors/corp-dc-1/tunnels/tun-1/sessions/sess-1/heartbeat", { method: "POST", body: {} });
  check(
    "seed: two items need approval, one blocked",
    approveMe.status === "needs_approval" && rejectMe.status === "needs_approval" && blocked.status === "blocked"
  );

  browser = await launchBrowser({ port: Number(process.env.ACS_E2E_CDP_PORT ?? 9337) });
  page = await browser.newPage();
  await page.setViewport(1440, 900);
  const nav = async (path) => {
    await page.eval((p) => {
      history.pushState(null, "", p);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/console${path}`);
  };
  const posts = (needle) => page.requests.filter((r) => r.method === "POST" && r.url.includes(needle));

  // 1. sign in through the real UI ------------------------------------------------
  await page.goto(`${base}/console/overview`);
  await page.waitFor(() => !!document.querySelector("input[type=password]"));
  check(
    "unauthenticated visit shows sign-in, not data",
    await page.eval(() => !document.body.innerText.includes("Pending approvals"))
  );
  await page.type("input[type=password]", "definitely-wrong");
  await page.click("button[type=submit]");
  await page.waitFor(() => /Token not accepted/.test(document.body.innerText));
  check("wrong token is rejected explicitly (401 → 'Token not accepted')", true);
  await page.type("input[type=password]", token);
  await page.click("button[type=submit]");
  await page.waitFor(() => !!document.querySelector("[data-testid=page-overview]"), 15000);
  check("sign-in reaches Overview", true);
  check(
    "token is not readable by page script (HttpOnly cookie, no storage)",
    await page.eval(
      () => !document.cookie.includes("acs_session") && localStorage.length === 0 && sessionStorage.length === 0
    )
  );
  await page.waitFor(() => /Event\s+Stream\s+Live/.test(document.body.innerText), 10000);
  check("event stream reports Live", true);
  check(
    "Overview shows real pending-approval count",
    await page.eval(() =>
      [...document.querySelectorAll("[data-testid=page-overview] .stat")].some(
        (card) =>
          card.querySelector(".stat-label")?.textContent?.trim() === "Pending approvals" &&
          /^[1-9]/.test(card.querySelector(".stat-value")?.textContent?.trim() ?? "")
      )
    )
  );

  // 2. every route renders ----------------------------------------------------------
  for (const r of [
    "work",
    "execution",
    "approvals",
    "agents",
    "connectors",
    "policy",
    "audit",
    "metrics",
    "system",
    "overview"
  ]) {
    await nav(`/${r}`);
    const ok = await page
      .waitFor((id) => !!document.querySelector(`[data-testid=page-${id}]`), 15000, r)
      .then(
        () => true,
        () => false
      );
    check(`route /console/${r} renders`, ok);
  }

  // 3. work item detail + deep link + refresh ----------------------------------------
  await nav("/work");
  await page.waitFor(() => !!document.querySelector("[data-testid=page-work] tbody tr"));
  await page.clickText("wrk_", "tr");
  await page.waitFor(() => !!document.querySelector("[data-testid=work-detail]"));
  const urlAfterClick = await page.eval(() => location.pathname);
  check("selecting a work item is represented in the URL", /^\/console\/work\/wrk_/.test(urlAfterClick), urlAfterClick);
  await page.goto(`${base}/console/work/${blocked.id}`);
  await page.waitFor(
    (id) => document.querySelector("[data-testid=work-detail]")?.getAttribute("data-work-item") === id,
    15000,
    blocked.id
  );
  check("deep link + hard refresh keeps the session and renders the record", true);
  await page.eval(() => history.back());
  await sleep(300);
  check("browser back/forward is honoured", await page.eval(() => location.pathname.startsWith("/console/")));

  // 4. filters/search in URL -------------------------------------------------------
  await page.goto(`${base}/console/work?status=blocked`);
  await page.waitFor(() => !!document.querySelector("[data-testid=page-work] tbody tr"));
  check(
    "status filter from URL applies",
    await page.eval(() =>
      [...document.querySelectorAll("[data-testid=page-work] tbody tr")].every((tr) => /Blocked/.test(tr.textContent))
    )
  );

  // 5. approvals: hash shown, reason enforced, double click, real backend state ---------
  await page.goto(`${base}/console/approvals/${approveMe.id}`);
  await page.waitFor(() => !!document.querySelector("[data-testid=work-detail]"));
  await page.clickText("Approval & actions", "[role=tab]");
  await page.waitFor(() => !!document.querySelector("[data-testid=action-hash]"));
  const shownHash = await page.eval(
    () => document.querySelector("[data-testid=action-hash]").textContent.match(/[a-f0-9]{64}/)?.[0]
  );
  const events = (await api(`/work-items/${approveMe.id}`)).body.events;
  const recorded = events.find(
    (e) => e.name === "policy.decided" && e.attributes["policy.decision"] === "require_approval"
  );
  check(
    "UI shows the exact action hash ACS recorded",
    shownHash && shownHash === recorded?.attributes["action.hash"],
    `${shownHash} vs ${recorded?.attributes["action.hash"]}`
  );
  await page.clickText("Approve this action");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  check(
    "approve opens a confirmation dialog naming the target and hash",
    await page.eval((h) => document.querySelector("dialog[open]").textContent.includes(h), shownHash)
  );
  await page.click("dialog[open] button[type=submit]");
  await page.waitFor(() => /reason is required/i.test(document.querySelector("dialog[open]")?.textContent ?? ""));
  check("approval without a reason is blocked client-side (no request sent)", posts("/approve").length === 0);
  await page.type("dialog[open] textarea", "E2E: verified action is acceptable");
  await page.eval(() => {
    const b = document.querySelector("dialog[open] button[type=submit]");
    b.click();
    b.click();
    b.click();
  });
  await page.waitFor(async () => !document.querySelector("dialog[open]"), 10000);
  await sleep(600);
  check(
    "triple-click submits exactly ONE approve request",
    posts(`/work-items/${approveMe.id}/approve`).length === 1,
    String(posts("/approve").length)
  );
  const after = (await api(`/work-items/${approveMe.id}`)).body;
  check("backend: work item is approved", after.workItem.status === "approved", after.workItem.status);
  const granted = after.events.find((e) => e.name === "approval.granted");
  check(
    "backend: audit records approval bound to the same hash and reason",
    granted?.body.actionHash === shownHash &&
      granted?.body.reason === "E2E: verified action is acceptable" &&
      granted?.body.approvedBy === "operator-e2e"
  );
  await page.waitFor(() => /Approved/.test(document.body.innerText), 8000);
  check("UI reflects the authoritative state without reload", true);
  const again = await api(`/work-items/${approveMe.id}/approve`, {
    method: "POST",
    body: { reason: "repeat", actionHash: shownHash }
  });
  const afterRepeat = (await api(`/work-items/${approveMe.id}`)).body;
  check(
    "backend: a repeated approve leaves the item approved and creates no execution attempt",
    afterRepeat.workItem.status === "approved" && afterRepeat.executionAttempts.length === 0,
    `${again.status}`
  );
  const wrongHash = await api(`/work-items/${rejectMe.id}/approve`, {
    method: "POST",
    body: { reason: "wrong hash", actionHash: "0".repeat(64) }
  });
  check(
    "backend: approving with a stale/wrong action hash fails closed",
    wrongHash.status >= 400 && (await api(`/work-items/${rejectMe.id}`)).body.workItem.status === "needs_approval",
    `${wrongHash.status} ${JSON.stringify(wrongHash.body).slice(0, 120)}`
  );

  // 6. reject -------------------------------------------------------------------------
  await page.goto(`${base}/console/approvals/${rejectMe.id}`);
  await page.waitFor(() => !!document.querySelector("[data-testid=work-detail]"));
  await page.clickText("Approval & actions", "[role=tab]");
  await page.clickText("Reject");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  await page.type("dialog[open] textarea", "E2E: not acceptable");
  await page.click("dialog[open] button[type=submit]");
  await page.waitFor(() => !document.querySelector("dialog[open]"), 10000);
  await sleep(500);
  check(
    "backend: reject moves item to rejected",
    (await api(`/work-items/${rejectMe.id}`)).body.workItem.status === "rejected"
  );

  // 7. unblock: backend policy still denies → UI must show the refusal, not success -------
  await page.goto(`${base}/console/work/${blocked.id}`);
  await page.waitFor(() => !!document.querySelector("[data-testid=work-detail]"));
  await page.clickText("Approval & actions", "[role=tab]");
  await page.clickText("Unblock");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  await page.click("dialog[open] button[type=submit]");
  await page.waitFor(() => /Not completed/.test(document.querySelector("dialog[open]")?.textContent ?? ""), 8000);
  check(
    "unblock denied by policy shows the backend refusal (403), never success",
    await page.eval(
      () =>
        /Not permitted|HTTP 403/.test(document.querySelector("dialog[open]").textContent) &&
        !/Unblock evaluated/.test(document.body.innerText)
    )
  );
  await page.clickText("Cancel", "dialog[open] button");
  check(
    "backend: unblock did not change a policy-denied item",
    (await api(`/work-items/${blocked.id}`)).body.workItem.status === "blocked"
  );

  // 8. cancel ----------------------------------------------------------------------------
  const cancelMe = (await mk("E2E cancel me", "high", "fs.write", { path: "d.txt", content: "q" })).body;
  await page.goto(`${base}/console/work/${cancelMe.id}`);
  await page.waitFor(() => !!document.querySelector("[data-testid=work-detail]"));
  await page.clickText("Approval & actions", "[role=tab]");
  await page.clickText("Cancel work item");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  await page.click("dialog[open] button[type=submit]");
  await page.waitFor(() => !document.querySelector("dialog[open]"), 10000);
  await sleep(400);
  check(
    "backend: cancel moves item to cancelled",
    (await api(`/work-items/${cancelMe.id}`)).body.workItem.status === "cancelled"
  );

  // 9. retry / clone need a terminal source -------------------------------------------------
  await page.goto(`${base}/console/work/${cancelMe.id}`);
  await page.waitFor(() => !!document.querySelector("[data-testid=work-detail]"));
  await page.clickText("Approval & actions", "[role=tab]");
  await page.clickText("Clone");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  await page.click("dialog[open] button[type=submit]");
  await page.waitFor(
    (id) => /\/console\/work\/wrk_/.test(location.pathname) && !location.pathname.endsWith(id),
    10000,
    cancelMe.id
  );
  check("clone creates a new governed item and navigates to it", true);

  // 10. XSS: event/work-item text is inert -------------------------------------------------
  await page.goto(`${base}/console/work/${xss.id}`);
  await page.waitFor(() => !!document.querySelector("[data-testid=work-detail]"));
  await sleep(500);
  check(
    "hostile title renders as literal text and never executes",
    await page.eval(() => window.__xss === undefined && document.body.innerText.includes("onerror"))
  );

  // 11. policy explain is simulation only ------------------------------------------------------
  const countBefore = (await api("/work-items")).body.workItems.length;
  await nav("/policy");
  await page.waitFor(() => !!document.querySelector("[data-testid=page-policy] form"));
  await page.type("[data-testid=page-policy] form input[required][aria-required]", "fs.write");
  await page.eval(() => {
    const i = document.querySelectorAll("[data-testid=page-policy] form input[required][aria-required]")[1];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "write a file");
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.eval(() => {
    const s = document.querySelectorAll("[data-testid=page-policy] form select")[1];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "high");
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const postsBefore = page.requests.filter((r) => r.method === "POST").length;
  await page.clickText("Explain decision");
  await page.waitFor(() => !!document.querySelector("[data-testid=explain-result]"), 8000);
  check(
    "policy explain shows decision, rules and hash",
    await page.eval(
      () =>
        /Approval required/.test(document.querySelector("[data-testid=explain-result]").textContent) &&
        /approval:risk/.test(document.querySelector("[data-testid=explain-result]").textContent)
    )
  );
  const newPosts = page.requests.filter((r) => r.method === "POST").slice(postsBefore);
  check(
    "policy explain created no work item and issued only POST /policy/explain",
    (await api("/work-items")).body.workItems.length === countBefore &&
      newPosts.length === 1 &&
      newPosts[0].url.endsWith("/policy/explain"),
    JSON.stringify(newPosts)
  );

  // 12. live audit stream updates without reload ---------------------------------------------------
  await nav("/audit");
  await page.waitFor(() => !!document.querySelector("[data-testid=page-audit] tbody tr"));
  const liveItem = (await mk(`E2E live event ${Date.now()}`, "high", "fs.write", { path: "e.txt", content: "w" })).body;
  await page.waitFor(
    (id) => document.querySelector("[data-testid=page-audit] tbody").innerText.includes(id),
    8000,
    liveItem.id
  );
  check("audit page shows new events live over SSE", true);
  await page.click("[data-testid=page-audit] tbody tr");
  await page.waitFor(() => !!document.querySelector("[data-testid=audit-detail]"));
  await page.clickText("Payload", "[role=tab]");
  await page.waitFor(() => !!document.querySelector("[data-testid=audit-detail] pre.json"));
  check("audit detail renders payload as inert JSON text", true);

  // 13. connectors: destructive action confirms first --------------------------------------------------
  await page.goto(`${base}/console/connectors/corp-dc-1`);
  await page.waitFor(() => !!document.querySelector("[data-testid=connector-detail]"));
  await page.clickText("Tunnel sessions", "[role=tab]");
  await page.clickText("Revoke");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  check(
    "revoke tunnel session asks for confirmation naming the session",
    await page.eval(() => /sess-1/.test(document.querySelector("dialog[open]").textContent))
  );
  check("no revoke request before confirmation", posts("/revoke").length === 0);
  await page.clickText("Cancel", "dialog[open] button");
  await sleep(200);
  check("cancelling the dialog sends nothing", posts("/revoke").length === 0);
  await page.clickText("Revoke");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  await page.click("dialog[open] button[type=submit]");
  await page.waitFor(() => !document.querySelector("dialog[open]"), 8000);
  await sleep(800);
  check("revoke sends exactly one POST after confirmation", posts("/revoke").length === 1);
  check(
    "UI shows the session revoked from refetched audit state",
    await page.eval(() => /Revoked/.test(document.querySelector("[data-testid=connector-detail]").innerText))
  );

  // 14. agents: heartbeat semantics --------------------------------------------------------------
  await nav("/agents");
  await page.waitFor(() => /Analyst 1/.test(document.body.innerText));
  const rows = await page.eval(() =>
    [...document.querySelectorAll("[data-testid=page-agents] tbody tr")].map((tr) => tr.innerText.replace(/\s+/g, " "))
  );
  check(
    "agent with fresh heartbeat is Online; agent without heartbeat is not",
    rows.some((r) => /Analyst 1/.test(r) && /Online/.test(r)) &&
      rows.some((r) => /Quiet 2/.test(r) && !/Online/.test(r)),
    JSON.stringify(rows.filter((r) => /Analyst|Quiet/.test(r)))
  );

  // 14b. create a governed work item and register an agent through the UI ----------------------------
  await nav("/work");
  await page.waitFor(() => !!document.querySelector("[data-testid=page-work]"));
  await page.clickText("New work item");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  const setField = (labelStart, value) =>
    page.eval(
      (start, val) => {
        const label = [...document.querySelectorAll("dialog[open] label")].find((l) =>
          l.textContent.trim().startsWith(start)
        );
        const el = label.querySelector("input, textarea, select");
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : el instanceof HTMLSelectElement
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      },
      labelStart,
      value
    );
  await setField("Title", "E2E created from UI");
  await setField("Intent", "Created through the Mission Control dialog");
  await setField("Risk", "high");
  await setField("Action kind", "fs.write");
  await setField("Action description", "write ui.txt");
  await setField("Action parameters", '{"path":"ui.txt","content":"v"}');
  await page.click("dialog[open] button[type=submit]");
  await page.waitFor(() => /\/console\/work\/wrk_/.test(location.pathname), 10000);
  const createdId = await page.eval(() => location.pathname.split("/").pop());
  const createdBackend = (await api(`/work-items/${createdId}`)).body.workItem;
  check(
    "UI-created work item exists in ACS with server-derived requester and policy-assigned status",
    createdBackend.title === "E2E created from UI" &&
      createdBackend.requester === "user" &&
      createdBackend.requesterSubject === "operator-e2e" &&
      createdBackend.status === "needs_approval",
    JSON.stringify({ r: createdBackend.requester, s: createdBackend.requesterSubject, st: createdBackend.status })
  );
  await nav("/agents");
  await page.waitFor(() => !!document.querySelector("[data-testid=page-agents]"));
  await page.clickText("Register agent");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  await setField("Agent ID", "ui-agent-1");
  await setField("Display name", "UI Agent 1");
  await page.click("dialog[open] button[type=submit]");
  await page.waitFor(() => !document.querySelector("dialog[open]"), 10000);
  await page.waitFor(() => /UI Agent 1/.test(document.body.innerText), 8000);
  const uiRow = await page.eval(() =>
    [...document.querySelectorAll("[data-testid=page-agents] tbody tr")]
      .find((r) => /UI Agent 1/.test(r.innerText))
      ?.innerText.replace(/\s+/g, " ")
  );
  check("a newly registered agent is NOT online until it heartbeats", !!uiRow && !/Online/.test(uiRow), uiRow);

  // 15. system distinguishes LIVE / READY / HEALTHY, metrics renders ------------------------------
  await nav("/system");
  await page.waitFor(() => !!document.querySelector("[data-testid=probe-live]"));
  check(
    "System shows LIVE, READY and HEALTHY as separate probes",
    await page.eval(() => ["live", "ready", "healthy"].every((n) => document.querySelector(`[data-testid=probe-${n}]`)))
  );
  await nav("/metrics");
  await page.waitFor(() => /Queue depth/.test(document.body.innerText));
  check("Metrics renders real /metrics-derived stats", await page.eval(() => /HTTP 429/.test(document.body.innerText)));

  // 16. fail-closed when the live stream cannot be established ---------------------------------------
  const page2 = await browser.newPage();
  await page2.setViewport(1440, 900);
  await page2.send("Network.setBlockedURLs", { urls: [`${base}/events`] });
  await page2.goto(`${base}/console/overview`);
  // The tab shares the browser profile, so the session cookie from the first tab is reused (auth survives across tabs and reloads).
  await page2
    .waitFor(() => !!document.querySelector("[data-testid=page-overview]"), 15000)
    .catch(async (e) => {
      console.log("page2 text:", await page2.eval(() => document.body.innerText.slice(0, 300)), page2.consoleErrors);
      throw e;
    });
  check("a second tab reuses the session cookie without signing in again", true);
  await page2.eval((id) => {
    history.pushState(null, "", `/console/approvals/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, xss.id);
  await page2.waitFor(() => !!document.querySelector("[data-testid=work-detail]"));
  await page2.clickText("Approval & actions", "[role=tab]");
  await page2.waitFor(() => !!document.querySelector("[data-testid=work-actions]"));
  check("stale-stream banner is visible", await page2.eval(() => !!document.querySelector("#stream-stale-banner")));
  check(
    "approve/reject are DISABLED while the stream is not live",
    await page2.eval(() => {
      const q = (t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(t));
      return q("Approve this action").disabled && q("Reject").disabled;
    })
  );
  await page2.close();

  // 17. responsive ------------------------------------------------------------------------------------
  for (const [w, h, label] of [
    [1280, 800, "1280"],
    [820, 1100, "tablet"],
    [390, 844, "mobile"]
  ]) {
    await page.setViewport(w, h, w < 720);
    for (const r of [
      "overview",
      "work",
      "execution",
      "approvals",
      "agents",
      "connectors",
      "policy",
      "audit",
      "metrics",
      "system"
    ]) {
      await page.goto(`${base}/console/${r}`);
      await page.waitFor((id) => !!document.querySelector(`[data-testid=page-${id}]`), 15000, r);
      await sleep(400);
      const overflow = await page.eval(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`no page-level horizontal overflow: ${r} @ ${label}`, overflow <= 1, `overflow ${overflow}px`);
      if (shots) await page.screenshot(join(shots, `${r}-${label}.png`));
    }
  }
  await page.setViewport(390, 844, true);
  await page.goto(`${base}/console/overview`);
  await page.waitFor(() => !!document.querySelector("[data-testid=page-overview]"));
  check(
    "mobile: navigation collapses behind a toggle",
    await page.eval(() => getComputedStyle(document.querySelector(".nav-toggle")).display !== "none")
  );

  // Inspect populated detail panels and run WCAG checks on every route. All
  // records here live only in the disposable gateway, never production state.
  await page.setViewport(1280, 800);
  const eventsForQa = (await api("/api/events?limit=500")).body.events;
  const detailPaths = {
    execution: `/execution/${executing.id}`,
    work: `/work/${approveMe.id}`,
    approvals: `/approvals/${xss.id}`,
    agents: "/agents/analyst-1",
    connectors: "/connectors/corp-dc-1",
    audit: `/audit/${eventsForQa.at(-1).id}`
  };
  const axeSource = readFileSync(resolve(root, "node_modules/axe-core/axe.min.js"), "utf8");
  for (const route of [
    "overview",
    "work",
    "execution",
    "approvals",
    "agents",
    "connectors",
    "policy",
    "audit",
    "metrics",
    "system"
  ]) {
    await page.goto(`${base}/console${detailPaths[route] ?? `/${route}`}`);
    await page.waitFor((id) => !!document.querySelector(`[data-testid=page-${id}]`), 15000, route);
    await sleep(500);
    if (route === "execution") {
      await page.waitFor(() => !!document.querySelector("[data-testid=execution-detail]"));
      check(
        "execution detail shows stored plan objective and fenced worker",
        await page.eval(
          () =>
            document.body.innerText.includes("Read the workspace manifest") &&
            document.body.innerText.includes("worker-e2e")
        )
      );
    }
    await page.send("Runtime.evaluate", { expression: axeSource });
    const violations = await page.eval(async () => {
      const result = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] }
      });
      return result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }));
    });
    check(`WCAG automated checks: ${route}`, violations.length === 0, JSON.stringify(violations));
    const detailOverflow = await page.eval(() =>
      [...document.querySelectorAll(".detail")].some((el) => el.scrollWidth > el.clientWidth + 1)
    );
    check(`no horizontal overflow inside detail: ${route}`, !detailOverflow);
    if (shots) await page.screenshot(join(shots, `${route}-detail-1280.png`));
  }

  // 18. console hygiene ----------------------------------------------------------------------------------
  const noisy = [...page.consoleErrors, ...page.pageErrors].filter((e) => !/status of (401|403|409|400)/.test(e));
  check(
    "no unexpected console errors or unhandled exceptions",
    noisy.length === 0,
    JSON.stringify(noisy).slice(0, 400)
  );
  check("no CSP violations", page.cspViolations.length === 0, JSON.stringify(page.cspViolations));
} catch (error) {
  check("e2e run completed without an unexpected error", false, error instanceof Error ? error.stack : String(error));
  try {
    const metrics = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}` } })).text();
    console.log(
      "gateway sse/http metrics at failure:\n" +
        metrics
          .split("\n")
          .filter((l) => /sse|route="\/events"|route="\/work-items\/:id"/.test(l) && !l.startsWith("#"))
          .join("\n")
    );
  } catch (e) {
    console.log("metrics unavailable", e.message);
  }
  if (page) {
    console.log("in-flight browser requests at failure:", [...page.inflight.values()]);
    console.log(
      "page text at failure:",
      await page
        .eval(() => `${location.pathname}\n${document.body.innerText.slice(0, 600)}`)
        .catch(() => "<unavailable>")
    );
    console.log(
      "detail fetch at failure:",
      await page
        .eval(async () => {
          const t0 = Date.now();
          const r = await fetch(location.pathname.replace("/console/work/", "/work-items/") + "?limit=500");
          return `${r.status} in ${Date.now() - t0}ms ${(await r.text()).slice(0, 160)}`;
        })
        .catch((e) => `ERR ${e.message}`)
    );
    if (shots) await page.screenshot(join(shots, "failure.png")).catch(() => undefined);
  }
} finally {
  await browser?.close();
  gateway.kill();
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
