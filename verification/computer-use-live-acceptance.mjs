#!/usr/bin/env node
/**
 * Live ACS Computer Use acceptance. Reads signing material from the operator
 * env files already used by the systemd units. Never prints those secrets.
 *
 *   node verification/computer-use-live-acceptance.mjs
 *
 * Evidence (no credentials) is written under ~/.local/state/acs-gui-rollout/.
 */
import { createHmac, randomBytes, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const EDGE = "http://127.0.0.1:8010/jc/mcp";
const BRIDGE = "http://127.0.0.1:8003";
const ACS = "http://127.0.0.1:3000";
const DISPLAY = ":81";
const XAUTH = path.join(HOME, ".local/state/acs-gui-display/Xauthority");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.join(HOME, ".local/state/acs-gui-rollout", `live-${STAMP}`);
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 500) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ""}`);
}

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let value = line.slice(i + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, i)] = value;
  }
  return out;
}

function operatorCredential() {
  const env = readEnvFile(path.join(HOME, ".config/acs/acs-gateway.env"));
  const creds = JSON.parse(env.ACS_GATEWAY_CREDENTIALS_JSON);
  const operator = creds.find(
    (entry) =>
      (entry.actorId === "omarchy-operator" || entry.id === "omarchy-operator") &&
      Array.isArray(entry.scopes) &&
      entry.scopes.includes("acs:approve")
  );
  if (!operator?.token) throw new Error("operator credential missing");
  return operator.token;
}

const edgeEnv = readEnvFile(path.join(HOME, ".config/acs/jc-edge.env"));
const OPERATOR = operatorCredential();
const ORIGIN = edgeEnv.PUBLIC_ORIGIN;
const DB = "/home/jacen/.local/state/acs/gateway/local.db";

function mintToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64u({ alg: "HS256", typ: "JWT" });
  const payload = b64u({
    iss: `${ORIGIN}/jc`,
    sub: "jacen",
    client_id: "jc-acceptance-verifier",
    aud: `${ORIGIN}/jc/mcp`,
    scope: "mcp",
    iat: now,
    exp: now + 600,
    jti: randomBytes(12).toString("base64url"),
    ...overrides
  });
  const key = overrides.signingKey ?? edgeEnv.SIGNING_KEY;
  const sig = createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function parseBody(text) {
  if (text.startsWith("event:")) {
    const line = text.split("\n").find((item) => item.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class LiveMcpClient {
  constructor(token = mintToken()) {
    this.token = token;
    this.sessionId = null;
    this.nextId = 1;
  }
  async post(payload, extra = {}) {
    const res = await fetch(EDGE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...extra
      },
      body: JSON.stringify(payload)
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const raw = await res.text();
    return { status: res.status, body: parseBody(raw), raw };
  }
  async init() {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acs-cu-live", version: "1" } }
    });
    if (res.status === 200) await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return res;
  }
  async listTools() {
    return this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} });
  }
  async call(name, args = {}) {
    return this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
  }
}

async function approve(workItemId, actionHash) {
  const res = await fetch(`${ACS}/work-items/${workItemId}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    body: JSON.stringify({ actionHash, reason: "computer-use live acceptance" })
  });
  return { status: res.status, body: await res.json() };
}

async function workItem(id) {
  const res = await fetch(`${ACS}/work-items/${id}`, { headers: { authorization: `Bearer ${OPERATOR}` } });
  return { status: res.status, body: await res.json() };
}

function denial(body) {
  return body?.error?.data?.kind === "managed_authorization_denied";
}

async function callApproved(client, name, args) {
  const held = await client.call(name, args);
  if (!denial(held.body)) return { executed: held, held };
  const workItemId = held.body.error.data.workItemId;
  const wi = await workItem(workItemId);
  const policyEvent = (wi.body.events ?? []).find((event) => event.name === "policy.decided");
  const actionHash = policyEvent?.body?.actionHash;
  const approval = await approve(workItemId, actionHash);
  const executed = await client.call(name, args);
  return { held, wi, actionHash, approval, executed, workItemId };
}

function xenv() {
  return { ...process.env, DISPLAY, XAUTHORITY: XAUTH, PATH: "/usr/bin:/bin" };
}

function compileLogger() {
  const source = `
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  Display *d = XOpenDisplay(NULL);
  if (!d) return 1;
  int s = DefaultScreen(d);
  Window w = XCreateSimpleWindow(d, RootWindow(d, s), 80, 60, 480, 320, 2, BlackPixel(d, s), WhitePixel(d, s));
  XStoreName(d, w, "acs-cu-logger");
  XSelectInput(d, w, ExposureMask | KeyPressMask | ButtonPressMask);
  XMapWindow(d, w);
  XFlush(d);
  FILE *f = fopen(argv[1], "a");
  if (!f) return 3;
  fprintf(f, "mapped\\n");
  fflush(f);
  for (;;) {
    XEvent e;
    XNextEvent(d, &e);
    if (e.type == ButtonPress) {
      fprintf(f, "button %d root %d %d\\n", e.xbutton.button, e.xbutton.x_root, e.xbutton.y_root);
      fflush(f);
    } else if (e.type == KeyPress) {
      KeySym sym = XLookupKeysym(&e.xkey, 0);
      char buf[32];
      XLookupString(&e.xkey, buf, sizeof buf, &sym, 0);
      fprintf(f, "key %lu %s\\n", (unsigned long)sym, buf);
      fflush(f);
    }
  }
}
`;
  const src = path.join(OUT, "logger.c");
  const bin = path.join(OUT, "logger");
  fs.writeFileSync(src, source);
  execFileSync("gcc", ["-O2", "-o", bin, src, "-lX11"], { stdio: "pipe" });
  return bin;
}

function readEvents(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function sql(query) {
  return execFileSync("sqlite3", ["-separator", "|", DB, query], { encoding: "utf8" }).trim();
}

async function deployedLeaseModule() {
  const exec = execFileSync("systemctl", ["--user", "show", "-p", "ExecStart", "acs-recovery.service"], { encoding: "utf8" });
  const match = exec.match(/\/home\/jacen\/\.local\/lib\/acs-gateway\/releases\/[^ ;]+/);
  if (!match) throw new Error("acs-recovery ExecStart has no release path");
  const root = match[0].replace(/\/apps\/gateway\/dist\/cli\.js$/, "");
  return { root, observe: (await import(path.join(root, "packages/policy-gate/dist/managed-authority.js"))).observeManagedAuthority };
}

async function main() {
  console.log(`evidence ${OUT}`);
  const noAuth = await fetch(EDGE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "x", version: "0" } } })
  });
  check("missing bearer is denied", noAuth.status === 401, String(noAuth.status));

  const forged = await fetch(EDGE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mintToken({ signingKey: "invalid-signing-key-not-the-real-one-0000" })}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "x", version: "0" } } })
  });
  check("forged bearer is denied", forged.status === 401, String(forged.status));

  const now = Math.floor(Date.now() / 1000);
  const expired = await fetch(EDGE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mintToken({ iat: now - 3600, exp: now - 60 })}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "x", version: "0" } } })
  });
  check("expired bearer is denied", expired.status === 401, String(expired.status));

  const direct = await fetch(`${BRIDGE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "x", version: "0" } } })
  });
  check("direct bridge bypass is denied", direct.status === 401, String(direct.status));

  const client = new LiveMcpClient();
  const stale = await client.post(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gui_screenshot", arguments: {} } },
    { "mcp-session-id": "00000000-0000-0000-0000-000000000000" }
  );
  check("stale session fails closed", stale.status === 400, String(stale.status));

  const init = await client.init();
  check("MCP initialize", init.status === 200 && Boolean(client.sessionId), client.sessionId ?? "");
  const listed = await client.listTools();
  const names = (listed.body?.result?.tools ?? []).map((tool) => tool.name);
  check("MCP lists gui_screenshot and gui_action", names.includes("gui_screenshot") && names.includes("gui_action"), `tools=${names.length}`);

  const status = await client.call("jc_status", {});
  check("unrelated jc_status still works", status.status === 200 && status.body?.result, status.body?.error?.message ?? "ok");

  const other = new LiveMcpClient();
  await other.init();
  const shots = await Promise.all([client.call("gui_screenshot", {}), other.call("gui_screenshot", {})]);
  const shotOk = shots.every((shot) => shot.body?.result?.content?.some((part) => part.type === "image" && part.mimeType === "image/png"));
  check("concurrent authorized screenshots succeed", shotOk, shots.map((shot) => shot.body?.error?.message ?? "ok").join(","));
  const image = shots[0].body?.result?.content?.find((part) => part.type === "image");
  const meta = JSON.parse(shots[0].body.result.content.find((part) => part.type === "text").text);
  const png = Buffer.from(image.data, "base64");
  const pngPath = path.join(OUT, "screenshot.png");
  fs.writeFileSync(pngPath, png);
  check("screenshot is 1280x800 PNG", meta.width === 1280 && meta.height === 800 && png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), `${meta.width}x${meta.height} sha256=${createHash("sha256").update(png).digest("hex").slice(0, 16)}`);

  const unapproved = await client.call("gui_action", { action: "move", x: 40, y: 40 });
  check(
    "unapproved gui_action is denied",
    denial(unapproved.body) && unapproved.body.error.data.reason === "GUI control requires a human decision",
    unapproved.body?.error?.data?.reason ?? unapproved.body?.error?.message ?? ""
  );
  const deniedId = unapproved.body?.error?.data?.workItemId;
  const deniedItem = deniedId ? await workItem(deniedId) : null;
  check("denied action is needs_approval", deniedItem?.body?.workItem?.status === "needs_approval", deniedItem?.body?.workItem?.status ?? "");

  const bin = compileLogger();
  const events = path.join(OUT, "events.log");
  const child = spawn(bin, [events], { env: xenv(), stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  check("isolated logger is running", !child.killed && child.exitCode === null, `pid=${child.pid}`);

  const move = await callApproved(client, "gui_action", { action: "move", x: 200, y: 160 });
  check("approved move executes", move.executed?.body?.result?.structuredContent?.ok === true, move.executed?.body?.error?.message ?? move.approval?.status);
  const click = await callApproved(client, "gui_action", { action: "click", x: 200, y: 160 });
  check("approved click executes", click.executed?.body?.result?.structuredContent?.ok === true, click.workItemId ?? "");
  const typed = await callApproved(client, "gui_action", { action: "type", text: "ACS-CU-OK" });
  check("approved typing executes", typed.executed?.body?.result?.structuredContent?.ok === true, "");
  const scroll = await callApproved(client, "gui_action", { action: "scroll", direction: "down", amount: 2 });
  check("approved scroll executes", scroll.executed?.body?.result?.structuredContent?.ok === true, "");
  const key = await callApproved(client, "gui_action", { action: "key", text: "ctrl+Return" });
  check("approved key combination executes", key.executed?.body?.result?.structuredContent?.ok === true, "");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const log = readEvents(events);
  fs.writeFileSync(path.join(OUT, "events.txt"), log);
  check("logger observed the click", /button 1 root 200 160/.test(log), log.split("\n").slice(0, 8).join(" | "));
  check("logger observed typed text", log.includes("ACS-CU-OK") || (log.match(/key /g) ?? []).length >= 8, `keys=${(log.match(/key /g) ?? []).length}`);
  check("logger observed scroll buttons", /button 5 /.test(log), "");

  const replay = await client.call("gui_action", { action: "move", x: 200, y: 160 });
  check("consumed approval cannot be replayed", denial(replay.body), replay.body?.error?.data?.kind ?? "");

  const offscreen = await callApproved(client, "gui_action", { action: "move", x: 2000, y: 10 });
  const offscreenText = JSON.stringify(offscreen.executed?.body ?? {});
  check(
    "coordinates outside the display are rejected after approval",
    /outside the isolated display|GUI_ARGUMENT_INVALID/.test(offscreenText) && offscreen.executed?.body?.result?.structuredContent?.ok !== true,
    offscreenText.slice(0, 220)
  );

  const issuance = sql(
    `SELECT capability_issuance_id, tool_name, approved_by_actor_id, action_hash, lease_id FROM jace_commander_capability_issuances WHERE work_item_id = '${click.workItemId}'`
  );
  const [capId, toolName, approver, actionHash, leaseId] = issuance.split("|");
  check("audit issuance records gui_action", toolName === "gui_action" && approver === "omarchy-operator" && actionHash === click.actionHash, capId ?? issuance);
  const chain = sql(
    `SELECT sequence, name, previous_hash, event_hash FROM audit_events WHERE json_extract(attributes, '$."work_item.id"') = '${click.workItemId}' ORDER BY sequence ASC`
  );
  const rows = chain ? chain.split("\n").map((line) => line.split("|")) : [];
  let intact = rows.length >= 4;
  for (let i = 1; i < rows.length; i += 1) if (rows[i][2] !== rows[i - 1][3]) intact = false;
  check("audit hash chain is intact", intact, `events=${rows.length} receipt=${rows.at(-1)?.[1] ?? ""} id=${rows.at(-1)?.[0] ?? ""}`);
  fs.writeFileSync(path.join(OUT, "audit.txt"), `${issuance}\n${chain}\n`);

  const { observe, root } = await deployedLeaseModule();
  const expiredLease = observe(
    {
      leaseExists: true,
      breakGlassExists: false,
      breakGlassRaw: null,
      leaseRaw: JSON.stringify({
        instanceId: "expired",
        pid: 1,
        expiresAt: 1,
        bootId: "boot",
        processStartTicks: "1",
        executorKind: "jace-commander",
        releaseRoot: "/home/jacen/.local/lib/jace-commander/current",
        releaseCommit: "deadbeef"
      })
    },
    {
      nowMs: Date.now(),
      bootId: "boot",
      processStartTicks: "1",
      launchArgs: [],
      pidAlive: () => true,
      managedExecutorPids: [1],
      holderCommand: "/usr/bin/node /home/jacen/.local/lib/jace-commander/current/dist/cli.js serve",
      competingExecutorRoots: ["/home/jacen/.local/lib/jace-commander/current"]
    }
  );
  check("deployed policy rejects an expired JC lease", expiredLease.authoritative === false && expiredLease.leaseActive === false, `${root} ${expiredLease.detail}`);

  const lockPath = path.join(HOME, ".desktop-commander/executor.lock");
  const before = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  check("live lease is jace-commander", before.executorKind === "jace-commander" && Number.isInteger(before.pid), `pid=${before.pid} commit=${before.releaseCommit}`);
  try {
    process.kill(before.pid, "SIGKILL");
  } catch (error) {
    check("executor crash signal", false, error.message);
  }
  let recovered = null;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const next = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (next.pid !== before.pid && next.executorKind === "jace-commander") {
        process.kill(next.pid, 0);
        recovered = next;
        break;
      }
    } catch {
      /* holder not back yet */
    }
  }
  check("executor crash respawns a new lease", Boolean(recovered), recovered ? `pid=${recovered.pid}` : "no new lease");
  const staleAfterCrash = await client.call("gui_screenshot", {});
  const staleText = JSON.stringify(staleAfterCrash.body ?? {});
  check("crashed executor session cannot be reused", /session unknown|reconnect/.test(staleText), staleText.slice(0, 180));
  const recoveredClient = new LiveMcpClient();
  const recoveredInit = await recoveredClient.init();
  const afterCrash = await recoveredClient.call("gui_screenshot", {});
  check(
    "screenshot works after executor respawn",
    recoveredInit.status === 200 && Boolean(afterCrash.body?.result?.content?.find((part) => part.mimeType === "image/png")),
    afterCrash.body?.error?.message ?? "ok"
  );

  child.kill("SIGTERM");
  execFileSync("systemctl", ["--user", "restart", "acs-computer-use-xvfb.service", "jace-commander-mcp.service", "acs-recovery.service"], { stdio: "pipe" });
  let healthy = false;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const bridgeReady = await (await fetch(`${BRIDGE}/ready`)).json();
      const acs = await (await fetch(`${ACS}/healthz`)).json();
      const xvfb = execFileSync("systemctl", ["--user", "is-active", "acs-computer-use-xvfb.service"], { encoding: "utf8" }).trim();
      if (bridgeReady.ready === true && bridgeReady.variant === "jc" && acs.ok === true && xvfb === "active") {
        healthy = true;
        break;
      }
    } catch {
      /* still starting */
    }
  }
  check("services recover after restart", healthy, "");
  const client2 = new LiveMcpClient();
  await client2.init();
  const finalShot = await client2.call("gui_screenshot", {});
  const finalImage = finalShot.body?.result?.content?.find((part) => part.type === "image");
  check("screenshot works on the restarted isolated desktop", finalImage?.mimeType === "image/png", finalShot.body?.error?.message ?? finalImage?.mimeType ?? "");
  if (finalImage?.data) fs.writeFileSync(path.join(OUT, "screenshot-after-restart.png"), Buffer.from(finalImage.data, "base64"));

  const install = execFileSync(
    "/home/jacen/projects/acs-computer-use-engine/apps/jace-commander/deploy/install-user-release.sh",
    ["--status"],
    { encoding: "utf8" }
  );
  check("JC rollback pointer exists", /current ->/.test(install) && /previous ->/.test(install), install.replaceAll("\n", " | "));

  const failed = results.filter((item) => !item.pass);
  const summary = { at: new Date().toISOString(), out: OUT, passed: results.length - failed.length, failed: failed.length, total: results.length, results };
  fs.writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify(summary, null, 2));
  console.log(`RESULT ${summary.passed}/${summary.total}`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error("ACCEPTANCE_CRASH", error?.message ?? error);
  process.exit(1);
});
