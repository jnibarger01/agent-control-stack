/**
 * Acceptance scenarios for automatic reauthentication detection, end to end across real components:
 * the real edge (apps/dc-mcp-gateway/server.js, spawned) -> the real ACS gateway (buildGateway, listening) ->
 * GET /api/mcp-clients, which is what Mission Control renders.
 *
 * The "client" is a protocol-faithful stand-in for ChatGPT/Claude: it sends bearer tokens, refreshes on 401
 * invalid_token, and re-authorizes when refresh fails. It never calls any ACS endpoint or "disconnects" anything.
 * That proves the detection mechanism. It does NOT prove how the real ChatGPT and Claude apps behave; that is the
 * manual live check in docs/plans/oauth-reauthentication-detection.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway, type GatewayCredential } from "./server.js";

const t = (name: string) => ["tok", name, "0123456789abcdef0123456789abcdef"].join("-");
const JC = t("jc");
const READER = t("reader");
const credentials: GatewayCredential[] = [
  {
    id: "jc-bridge",
    token: JC,
    actor: "agent",
    actorId: "acs-jc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  },
  { id: "reader", token: READER, actor: "user", actorId: "reader", roles: ["operator"], scopes: ["acs:read"] }
];

const KEY = "k".repeat(32);
const ORIGIN = "https://gw.test";
const RESOURCE = `${ORIGIN}/jc/mcp`;
const ISSUER = `${ORIGIN}/jc`;
const EDGE_DIR = fileURLToPath(new URL("../../dc-mcp-gateway/", import.meta.url));
const nowS = () => Math.floor(Date.now() / 1000);
const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");

function jwt(clientId: string, over: Record<string, unknown> = {}) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(
    JSON.stringify({
      iss: ISSUER,
      sub: "jacen",
      aud: RESOURCE,
      client_id: clientId,
      scope: "mcp",
      iat: nowS() - 10,
      exp: nowS() + 600,
      jti: randomUUID(),
      ...over
    })
  );
  return `${h}.${p}.${createHmac("sha256", KEY).update(`${h}.${p}`).digest("base64url")}`;
}

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function startAcs(existingRoot?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "acs-auth-e2e-"));
  const app = buildGateway({
    dbPath: join(root, "control.db"),
    logger: false,
    auth: { token: "", actor: "user", actorId: "user", credentials }
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  cleanup.push(async () => {
    await app.close().catch(() => undefined);
    if (!existingRoot) rmSync(root, { recursive: true, force: true });
  });
  const clients = async () =>
    (await fetch(`${url}/api/mcp-clients`, { headers: { authorization: `Bearer ${READER}` } }).then((r) =>
      r.json()
    )) as {
      summary: Record<string, number>;
      clients: Array<Record<string, any>>;
    };
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${JC}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  return { app, url, root, clients, post };
}

let nextPort = 19100;
async function startEdge(acsUrl: string, tokens: Record<string, unknown>, authEvents = true) {
  const port = nextPort++;
  const dir = mkdtempSync(join(tmpdir(), "edge-auth-e2e-"));
  writeFileSync(
    join(dir, "clients.json"),
    JSON.stringify({
      chatgpt: {
        client_name: "c",
        redirect_uris: ["https://a.test/cb"],
        token_endpoint_auth_method: "none",
        oauth_lane: "jc",
        scope: "mcp"
      },
      claude: {
        client_name: "c",
        redirect_uris: ["https://a.test/cb"],
        token_endpoint_auth_method: "none",
        oauth_lane: "jc",
        scope: "mcp"
      }
    })
  );
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens));
  const upstream = await import("node:http").then(
    (http) =>
      new Promise<import("node:http").Server>((resolve) => {
        const s = http.createServer((req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            req.url === "/authority"
              ? JSON.stringify({ variant: "jc" })
              : JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })
          );
        });
        s.listen(0, "127.0.0.1", () => resolve(s));
      })
  );
  const upPort = (upstream.address() as { port: number }).port;
  const child: ChildProcess = spawn(process.execPath, ["server.js"], {
    cwd: EDGE_DIR,
    env: {
      PATH: process.env.PATH,
      GATEWAY_PORT: String(port),
      PUBLIC_ORIGIN: ORIGIN,
      CONSENT_PASSPHRASE: "pass-phrase",
      SIGNING_KEY: KEY,
      DATA_DIR: dir,
      UPSTREAM: `http://127.0.0.1:${upPort}`,
      JC_ENABLED: "1",
      JC_UPSTREAM: `http://127.0.0.1:${upPort}`,
      ACS_GATEWAY_URL: acsUrl,
      ACS_JC_GATEWAY_TOKEN: JC,
      ...(authEvents ? { ACS_MCP_AUTH_EVENTS: "1" } : {})
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  cleanup.push(() => {
    child.kill("SIGKILL");
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const call = (bearer: string) =>
    fetch(`${base}/jc/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    });
  const refresh = (refreshToken: string, clientId: string) =>
    fetch(`${base}/token?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: RESOURCE
      }).toString()
    });
  /** The user reconnecting: the real authorize -> consent (passphrase) -> token exchange, with PKCE, like a client's browser flow. */
  const reauthorize = async (clientId: string) => {
    const redirectUri = "https://a.test/cb";
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "mcp",
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE
    };
    const page = await fetch(`${base}/authorize?${new URLSearchParams({ ...params, oauth_lane: "jc" })}`);
    expect(page.status).toBe(200);
    const consent = await fetch(`${base}/authorize/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, passphrase: "pass-phrase" }).toString()
    });
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
    const token = await fetch(`${base}/token?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        resource: RESOURCE
      }).toString()
    });
    expect(token.status).toBe(200);
    return (await token.json()) as { access_token: string; refresh_token: string };
  };
  return { call, refresh, reauthorize };
}

/** What a compliant connected app does: use the token; on 401 invalid_token refresh; if that fails, give up (user must reconnect). */
async function connectedAppSession(
  edge: Awaited<ReturnType<typeof startEdge>>,
  clientId: string,
  accessToken: string,
  refreshToken: string
) {
  let response = await edge.call(accessToken);
  if (response.status !== 401) return { reconnectNeeded: false, response };
  expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  const renewed = await edge.refresh(refreshToken, clientId);
  if (renewed.status !== 200) return { reconnectNeeded: true, response: renewed };
  const next = (await renewed.json()) as { access_token: string };
  response = await edge.call(next.access_token);
  return { reconnectNeeded: false, response };
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 4_000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

const record = (client_id: string, over: Record<string, unknown> = {}) => ({
  client_id,
  scope: "mcp",
  resource: RESOURCE,
  issuer: ISSUER,
  exp: nowS() + 86_400,
  active: true,
  ...over
});
const byId = (view: { clients: Array<Record<string, any>> }, id: string) => view.clients.find((c) => c.clientId === id);

describe("reauthentication detection, end to end", () => {
  it("a revoked/expired refresh token shows 'Reauthentication required' with no manual disconnect", async () => {
    const acs = await startAcs();
    const edge = await startEdge(acs.url, { RC: record("chatgpt", { exp: nowS() - 60 }) });
    const session = await connectedAppSession(edge, "chatgpt", jwt("chatgpt", { exp: nowS() - 5 }), "RC");
    expect(session.reconnectNeeded).toBe(true);
    const view = await eventually(acs.clients, (v) => byId(v, "chatgpt")?.auth?.state === "reauth_required");
    expect(byId(view, "chatgpt")?.auth).toMatchObject({ state: "reauth_required", failureReason: "refresh_expired" });
    expect(view.summary.reauthRequired).toBe(1);
  });

  it("a stale reuse of an old refresh token (lost response) is flagged, and the other client stays healthy", async () => {
    const acs = await startAcs();
    // R1 was rotated ten minutes ago and its successor R1b has not been used: a client that lost the refresh response.
    const edge = await startEdge(acs.url, {
      R1: record("chatgpt", { active: false, rotatedAt: nowS() - 600, successor: "R1b" }),
      R1b: record("chatgpt"),
      R2: record("claude")
    });
    expect((await connectedAppSession(edge, "claude", jwt("claude", { exp: nowS() - 5 }), "R2")).reconnectNeeded).toBe(
      false
    );
    expect((await edge.refresh("R1", "chatgpt")).status).toBe(400);
    const view = await eventually(acs.clients, (v) => byId(v, "chatgpt")?.auth?.state === "reauth_required");
    expect(byId(view, "chatgpt")?.auth).toMatchObject({ state: "reauth_required", failureReason: "refresh_reused" });
    expect(byId(view, "claude")?.auth.state).toBe("ok");
  });

  it("an expired-but-refreshable access token never raises a warning, and the next sign-in clears a real one", async () => {
    const acs = await startAcs();
    const edge = await startEdge(acs.url, { R1: record("chatgpt") });
    const session = await connectedAppSession(edge, "chatgpt", jwt("chatgpt", { exp: nowS() - 5 }), "R1");
    expect(session.reconnectNeeded).toBe(false);
    expect(session.response.status).toBe(200);
    const view = await eventually(acs.clients, (v) => Boolean(byId(v, "chatgpt")?.auth?.lastSuccessAt));
    expect(byId(view, "chatgpt")?.auth.state).toBe("ok");
    expect(view.summary.reauthRequired).toBe(0);

    // A real failure, then the user reconnects (a fresh grant reaches ACS): the warning clears itself.
    await acs.post("/mcp-clients/auth-event", {
      lane: "jc",
      clientId: "chatgpt",
      kind: "refresh_failed",
      reason: "revoked"
    });
    expect(byId(await acs.clients(), "chatgpt")?.auth.state).toBe("reauth_required");
    await acs.post("/mcp-clients/auth-event", { lane: "jc", clientId: "chatgpt", kind: "granted" });
    expect(byId(await acs.clients(), "chatgpt")?.auth.state).toBe("ok");
  });

  it("an idle client with a valid refresh token is never flagged, however long it is quiet", async () => {
    const acs = await startAcs();
    await acs.post("/mcp-clients/auth-event", {
      lane: "jc",
      clientId: "chatgpt",
      kind: "granted",
      refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
    });
    const view = await acs.clients();
    // An authorization alone is not activity, so the client is not "live"; and it is healthy regardless.
    expect(byId(view, "chatgpt")).toMatchObject({ live: false, auth: { state: "ok" } });
    // Liveness is separate from authorization: a long-quiet client is simply not live.
    expect(byId(view, "chatgpt")?.auth.failureReason).toBeUndefined();
  });

  it("a stale refresh expiry stays healthy until the edge confirms a permanent failure", async () => {
    const acs = await startAcs();
    await acs.post("/mcp-clients/auth-event", {
      lane: "jc",
      clientId: "chatgpt",
      kind: "granted",
      refreshExpiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    expect(byId(await acs.clients(), "chatgpt")?.auth.state).toBe("ok");
    await acs.post("/mcp-clients/auth-event", {
      lane: "jc",
      clientId: "chatgpt",
      kind: "refresh_failed",
      reason: "refresh_expired"
    });
    const view = await acs.clients();
    expect(byId(view, "chatgpt")?.auth).toMatchObject({ state: "reauth_required", failureReason: "refresh_expired" });
  });

  it("an ACS outage during sign-in changes nothing for the client and invents no warning later", async () => {
    const acs = await startAcs();
    const edge = await startEdge(acs.url, { R1: record("chatgpt") });
    await acs.post("/mcp-clients/auth-event", { lane: "jc", clientId: "chatgpt", kind: "granted" });
    await acs.app.close(); // ACS down: the edge's reports fail and are dropped
    const session = await connectedAppSession(edge, "chatgpt", jwt("chatgpt", { exp: nowS() - 5 }), "R1");
    expect(session.reconnectNeeded).toBe(false);
    expect(session.response.status).toBe(200);
    // ACS comes back on the same audit log: the outage left no trace and no warning.
    const restarted = await startAcs(acs.root);
    const view = await restarted.clients();
    expect(view.summary.reauthRequired).toBe(0);
    expect(byId(view, "chatgpt")?.auth.state).toBe("ok");
  });

  it("with the flag off (default) the edge reports nothing, so ACS shows no health, yet OAuth behaviour is unchanged", async () => {
    const acs = await startAcs();
    const edge = await startEdge(acs.url, { R1: record("chatgpt", { exp: nowS() - 60 }) }, false);
    expect(
      (await connectedAppSession(edge, "chatgpt", jwt("chatgpt", { exp: nowS() - 5 }), "R1")).reconnectNeeded
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect((await acs.clients()).clients).toEqual([]);
  });

  it("reconnect end to end: revoked -> Reauthentication required -> user signs in again -> cleared, and the new token works", async () => {
    const acs = await startAcs();
    const edge = await startEdge(acs.url, { RC: record("chatgpt", { exp: nowS() - 60 }) });
    expect(
      (await connectedAppSession(edge, "chatgpt", jwt("chatgpt", { exp: nowS() - 5 }), "RC")).reconnectNeeded
    ).toBe(true);
    const flagged = await eventually(acs.clients, (v) => byId(v, "chatgpt")?.auth?.state === "reauth_required");
    expect(byId(flagged, "chatgpt")?.auth.state).toBe("reauth_required");
    expect(flagged.summary.reauthRequired).toBe(1);

    const tokens = await edge.reauthorize("chatgpt"); // the real consent + PKCE flow, nothing sent to ACS by the test
    const cleared = await eventually(acs.clients, (v) => byId(v, "chatgpt")?.auth?.state === "ok");
    expect(byId(cleared, "chatgpt")?.auth.state).toBe("ok");
    expect(byId(cleared, "chatgpt")?.auth.failureReason).toBeUndefined();
    expect(Date.parse(byId(cleared, "chatgpt")?.auth.lastSuccessAt)).toBeGreaterThan(
      Date.parse(byId(flagged, "chatgpt")?.auth.lastFailureAt)
    );
    expect(cleared.summary.reauthRequired).toBe(0);
    expect((await edge.call(tokens.access_token)).status).toBe(200);
    expect((await edge.refresh(tokens.refresh_token, "chatgpt")).status).toBe(200);
  });
});
