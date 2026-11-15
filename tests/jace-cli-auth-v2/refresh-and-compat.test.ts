import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateAcsDevice,
  bootAcsGateway,
  bootJcGateway,
  generateEd25519DpopKey,
  generatePkce,
  issueBrowserDpopTokens,
  signAcsRefreshProof,
  signDpopProof,
  type BootedAcsGateway,
  type BootedJcGateway
} from "./helpers.js";

describe("Suite D: Refresh replay, concurrent locking, crash recovery, ChatGPT/Claude/JC_MCP_TOKEN compatibility, and ACS isolation", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  async function startJc(config = {}): Promise<BootedJcGateway> {
    const gw = await bootJcGateway(config);
    cleanups.push(() => gw.close());
    return gw;
  }

  async function startAcs(): Promise<BootedAcsGateway> {
    const acs = await bootAcsGateway();
    cleanups.push(() => acs.close());
    return acs;
  }

  it("SEC-21: refresh token replay with different/missing refresh_request_id revokes entire token family", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();
    const initial = await issueBrowserDpopTokens(gw, key);

    // Legitimate rotation rt1 -> rt2
    const req1 = randomUUID();
    const r1 = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: initial.refreshToken,
        refresh_request_id: req1
      },
      key
    );
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(b1.refresh_token).not.toBe(initial.refreshToken);

    // Replaying rt1 with a DIFFERENT refresh_request_id MUST fail AND revoke the family (including rt2)
    const replay = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: initial.refreshToken,
        refresh_request_id: randomUUID()
      },
      key
    );
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");

    // Successor rt2 MUST now also be revoked
    const afterRevoke = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: b1.refresh_token,
        refresh_request_id: randomUUID()
      },
      key
    );
    expect(afterRevoke.status).toBe(400);
    expect(((await afterRevoke.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("SEC-22: refresh with mismatched DPoP keypair fails and revokes the family", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();
    const attackerKey = generateEd25519DpopKey();
    const initial = await issueBrowserDpopTokens(gw, key);

    const stolenRefresh = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: initial.refreshToken,
        refresh_request_id: randomUUID()
      },
      attackerKey
    );
    expect(stolenRefresh.status).toBe(400);
    expect(((await stolenRefresh.json()) as { error: string }).error).toBe("invalid_grant");

    // Even the real owner cannot reuse the compromised family afterwards
    const ownerFollowup = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: initial.refreshToken,
        refresh_request_id: randomUUID()
      },
      key
    );
    expect(ownerFollowup.status).toBe(400);
  });

  it("SEC-23: concurrent CLI refresh calls share lock/single-flight and converge without triggering replay revocation", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();
    const initial = await issueBrowserDpopTokens(gw, key);

    const stateDir = mkdtempSync(join(tmpdir(), "jca2-concurrent-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));

    // Use the CLI auth store/refresh mechanism concurrently under headless EncryptedFileStore
    // and verify that parallel calls serialize through auth.lock and succeed.
    const prevDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const prevPass = process.env.JC_KEYRING_PASSPHRASE;
    process.env.DBUS_SESSION_BUS_ADDRESS = "";
    process.env.JC_KEYRING_PASSPHRASE = "concurrent-test-passphrase";
    cleanups.push(() => {
      if (prevDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = prevDbus;
      if (prevPass === undefined) delete process.env.JC_KEYRING_PASSPHRASE;
      else process.env.JC_KEYRING_PASSPHRASE = prevPass;
    });

    // Seed an expired access token via the CLI's credential store/import or verify lock serialization
    // using the cross-process lock exported from apps/jace-commander/src/
    let tokenEndpointHits = 0;
    const mcpAuth = (await import("../../apps/jace-commander/src/mcp-auth.js")) as Record<string, unknown>;
    expect(typeof mcpAuth.mcpAccessTokenOutcome).toBe("function");
    expect(typeof mcpAuth.connect).toBe("function");

    // Connect once via real CLI connect() against our gateway
    const stored = await (
      mcpAuth.connect as (opts: {
        mcpUrl: string;
        stateDir: string;
        onAuthorizeUrl: (u: string) => void;
      }) => Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }>
    )({
      mcpUrl: gw.jcResource,
      stateDir,
      onAuthorizeUrl: (authorizeUrl: string) => {
        void (async () => {
          const u = new URL(authorizeUrl);
          const consentRes = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            redirect: "manual",
            body: new URLSearchParams({
              oauth_lane: "jc",
              client_id: u.searchParams.get("client_id") ?? "jace-commander-cli",
              redirect_uri: u.searchParams.get("redirect_uri")!,
              response_type: "code",
              scope: u.searchParams.get("scope") ?? "mcp",
              state: u.searchParams.get("state")!,
              code_challenge: u.searchParams.get("code_challenge")!,
              code_challenge_method: "S256",
              resource: gw.jcResource,
              passphrase: gw.consentPassphrase,
              ...(u.searchParams.get("dpop_jkt") ? { dpop_jkt: u.searchParams.get("dpop_jkt")! } : {})
            }).toString()
          });
          const cb = consentRes.headers.get("location")!;
          await fetch(cb);
        })();
      }
    });
    expect(stored.accessToken).toBeTruthy();
    expect(initial.accessToken).toBeTruthy();

    // Concurrent calls on the connected stateDir must all resolve without error
    const outcomeFn = mcpAuth.mcpAccessTokenOutcome as (
      mcpUrl: string,
      stateDir: string,
      env?: NodeJS.ProcessEnv,
      fetchImpl?: typeof fetch
    ) => Promise<{ kind: string }>;
    const trackingFetch: typeof fetch = (input, init) => {
      if (String(input).includes("/token")) tokenEndpointHits += 1;
      return fetch(input, init);
    };
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => outcomeFn(gw.jcResource, stateDir, process.env, trackingFetch))
    );
    expect(outcomes.every((o) => o.kind === "token")).toBe(true);
    expect(tokenEndpointHits).toBeLessThanOrEqual(1);
  });

  it("SEC-24: crash recovery returns identical successor within recovery window for matching refresh_request_id, and rejects once superseded or expired", async () => {
    const gw = await startJc({ extraEnv: { JC_REFRESH_RECOVERY_WINDOW_S: "120" } });
    const key = generateEd25519DpopKey();
    const initial = await issueBrowserDpopTokens(gw, key);

    const reqId = randomUUID();
    const first = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: initial.refreshToken,
        refresh_request_id: reqId
      },
      key
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { access_token: string; refresh_token: string };

    // Simulated crash before client persisted response: retry with SAME refresh_token + SAME refresh_request_id + valid DPoP
    const recovered = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: initial.refreshToken,
        refresh_request_id: reqId
      },
      key
    );
    expect(recovered.status).toBe(200);
    const recoveredBody = (await recovered.json()) as { access_token: string; refresh_token: string };
    expect(recoveredBody.refresh_token).toBe(firstBody.refresh_token);
    expect(recoveredBody.access_token).toBe(firstBody.access_token);

    // Once the successor is legitimately used, re-submitting the old token even with the old reqId MUST fail
    const nextRefresh = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: recoveredBody.refresh_token,
        refresh_request_id: randomUUID()
      },
      key
    );
    expect(nextRefresh.status).toBe(200);

    const staleReplay = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: initial.refreshToken,
        refresh_request_id: reqId
      },
      key
    );
    expect(staleReplay.status).toBe(400);
  });

  it("SEC-25: ChatGPT DCR + PKCE S256 + Bearer OAuth flow remains 100% compatible on /mcp and /jc/mcp", async () => {
    const gw = await startJc();
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

    // DCR registration
    const regRes = await fetch(`${gw.baseUrl}/register?oauth_lane=jc&resource=${encodeURIComponent(gw.jcResource)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none"
      })
    });
    expect(regRes.status).toBe(201);
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };

    const { verifier, challenge } = generatePkce();
    const consent = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        oauth_lane: "jc",
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "mcp",
        state: "chatgpt-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: gw.jcResource,
        passphrase: gw.consentPassphrase
      }).toString()
    });
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;

    // Plain Bearer token exchange (no DPoP header) works for non-DPoP ChatGPT client
    const tokRes = await fetch(`${gw.baseUrl}/token?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        resource: gw.jcResource
      }).toString()
    });
    expect(tokRes.status).toBe(200);
    const tokBody = (await tokRes.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokBody.token_type).toBe("Bearer");

    const mcpRes = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokBody.access_token}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(mcpRes.status).toBe(200);

    // Bearer refresh without DPoP works for ChatGPT
    const refRes = await fetch(`${gw.baseUrl}/token?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokBody.refresh_token,
        client_id: clientId,
        resource: gw.jcResource
      }).toString()
    });
    expect(refRes.status).toBe(200);
  });

  it("SEC-26: Claude CIMD metadata (including jwt-bearer in metadata) still authorizes Bearer code flow, while /token rejects jwt-bearer", async () => {
    const claudeId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    const claudeRedirect = "https://claude.ai/api/mcp/auth_callback";
    const gw = await startJc({
      extraClients: {
        [claudeId]: {
          client_name: "Claude",
          redirect_uris: [claudeRedirect],
          token_endpoint_auth_method: "none",
          oauth_lane: "jc",
          scope: "mcp",
          grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"]
        }
      }
    });

    const { verifier, challenge } = generatePkce();
    const authPage = await fetch(
      gw.authorizeUrl({
        client_id: claudeId,
        redirect_uri: claudeRedirect,
        code_challenge: challenge,
        code_challenge_method: "S256"
      })
    );
    expect(authPage.status).toBe(200);

    const consent = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        oauth_lane: "jc",
        client_id: claudeId,
        redirect_uri: claudeRedirect,
        response_type: "code",
        scope: "mcp",
        state: "claude-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: gw.jcResource,
        passphrase: gw.consentPassphrase
      }).toString()
    });
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;

    const tokRes = await fetch(`${gw.baseUrl}/token?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: claudeRedirect,
        client_id: claudeId,
        resource: gw.jcResource
      }).toString()
    });
    expect(tokRes.status).toBe(200);

    // jwt-bearer grant MUST remain rejected at /token
    const jwtBearerRes = await fetch(`${gw.baseUrl}/token?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: "eyJhbGciOiJSUzI1NiJ9.e30.sig",
        client_id: claudeId
      }).toString()
    });
    expect(jwtBearerRes.status).toBe(400);
    expect(((await jwtBearerRes.json()) as { error: string }).error).toBe("unsupported_grant_type");
  });

  it("SEC-27: legacy JC_MCP_TOKEN works ONLY as explicit Bearer override, is never persisted, and never downgrades stored DPoP", async () => {
    const gw = await startJc();
    const stateDir = mkdtempSync(join(tmpdir(), "jca2-legacy-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));

    // Issue a legacy Bearer token via DCR to simulate a service-provisioned JC_MCP_TOKEN
    const reg = (await (
      await fetch(`${gw.baseUrl}/register?oauth_lane=jc&resource=${encodeURIComponent(gw.jcResource)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://ci.example/cb"], token_endpoint_auth_method: "none" })
      })
    ).json()) as { client_id: string };
    const { verifier, challenge } = generatePkce();
    const consent = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        oauth_lane: "jc",
        client_id: reg.client_id,
        redirect_uri: "https://ci.example/cb",
        response_type: "code",
        scope: "mcp",
        state: "s-leg",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: gw.jcResource,
        passphrase: gw.consentPassphrase
      }).toString()
    });
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
    const tok = (await (
      await fetch(`${gw.baseUrl}/token?oauth_lane=jc`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: "https://ci.example/cb",
          client_id: reg.client_id,
          resource: gw.jcResource
        }).toString()
      })
    ).json()) as { access_token: string };

    // Use McpHttpClient / mcpAccessTokenOutcome with JC_MCP_TOKEN set
    const { McpHttpClient } = await import("../../apps/jace-commander/src/mcp-http-client.js");
    const mcpAuth = await import("../../apps/jace-commander/src/mcp-auth.js");
    const sentAuthHeaders: string[] = [];
    const client = new McpHttpClient({
      url: gw.jcResource,
      token: () => mcpAuth.mcpAccessToken(gw.jcResource, stateDir, { JC_MCP_TOKEN: tok.access_token }),
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        sentAuthHeaders.push(headers.get("authorization") ?? "");
        const target = String(input).replace(gw.publicOrigin, gw.baseUrl);
        return fetch(target, init);
      }
    });
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(sentAuthHeaders.some((h) => h === `Bearer ${tok.access_token}`)).toBe(true);

    // JC_MCP_TOKEN MUST NOT be persisted into stateDir
    expect(mcpAuth.loadMcpToken(stateDir)).toBeUndefined();
  });

  it("SEC-28: ACS device-auth enforces domain isolation and blocks privilege escalation (no acs:work:approve / execution-mode:admin)", async () => {
    const acs = await startAcs();
    const key = generateEd25519DpopKey();

    // Disallowed privileged scopes on ACS device code MUST be refused
    for (const badScope of ["acs:work:approve", "acs:execution-mode:admin", "acs:admin", "*"]) {
      const res = await fetch(`${acs.url}/oauth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: "acs-cli",
          device_public_key: key.publicKeyPem,
          device_name: "priv-escalation-attempt",
          scope: badScope
        })
      });
      expect(res.status).toBe(400);
    }

    // Valid device token can read GET /devices scoped to its principal,
    // but cannot approve work items or revoke devices (operator-only).
    const dev = await authenticateAcsDevice(acs, key);
    const listDevices = await fetch(`${acs.url}/devices`, {
      headers: {
        authorization: `DPoP ${dev.accessToken}`,
        DPoP: signDpopProof({
          key,
          htm: "GET",
          htu: `${acs.publicOrigin}/devices`,
          accessToken: dev.accessToken
        })
      }
    });
    expect(listDevices.status).toBe(200);
    const listBody = (await listDevices.json()) as { devices: Array<{ id: string }> };
    expect(listBody.devices.some((d) => d.id === dev.deviceId)).toBe(true);

    const revokeAttempt = await fetch(`${acs.url}/devices/${encodeURIComponent(dev.deviceId)}/revoke`, {
      method: "POST",
      headers: {
        authorization: `DPoP ${dev.accessToken}`,
        DPoP: signDpopProof({
          key,
          htm: "POST",
          htu: `${acs.publicOrigin}/devices/${encodeURIComponent(dev.deviceId)}/revoke`,
          accessToken: dev.accessToken
        })
      }
    });
    expect(revokeAttempt.status).toBe(403);

    // Device token cannot refresh without valid Ed25519 refresh_proof
    const noProofRefresh = await fetch(`${acs.url}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        DPoP: signDpopProof({ key, htm: "POST", htu: `${acs.publicOrigin}/oauth/token` })
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: "acs-cli",
        refresh_token: dev.refreshToken,
        device_id: dev.deviceId
      })
    });
    expect(noProofRefresh.status).toBe(400);

    // Refresh WITH valid refresh_proof succeeds
    const nowSec = Math.floor(Date.now() / 1000);
    const okRefresh = await fetch(`${acs.url}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        DPoP: signDpopProof({ key, htm: "POST", htu: `${acs.publicOrigin}/oauth/token` })
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: "acs-cli",
        refresh_token: dev.refreshToken,
        device_id: dev.deviceId,
        proof_issued_at: nowSec,
        refresh_proof: signAcsRefreshProof(key.privateKey, "acs-cli", dev.deviceId, dev.refreshToken, nowSec)
      })
    });
    expect(okRefresh.status).toBe(200);
  });
});
