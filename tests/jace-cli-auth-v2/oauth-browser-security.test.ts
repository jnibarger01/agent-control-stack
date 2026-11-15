import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootAcsGateway,
  bootJcGateway,
  decodeJwtUnverified,
  generateEd25519DpopKey,
  generatePkce,
  issueBrowserDpopTokens,
  type BootedAcsGateway,
  type BootedJcGateway
} from "./helpers.js";

describe("Suite A: Browser OAuth 2.1, PKCE S256, state/iss, RFC 8252 loopback, audience/scope isolation", () => {
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

  it("SEC-01: browser login happy path with jace-commander-cli, loopback 127.0.0.1 & [::1], PKCE S256, RFC 9207 iss, and DPoP binding", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();

    // Verify metadata advertises DPoP + S256 + RFC 9207 iss.
    const asMetaRes = await fetch(`${gw.baseUrl}/jc/.well-known/oauth-authorization-server`);
    expect(asMetaRes.status).toBe(200);
    const asMeta = (await asMetaRes.json()) as Record<string, unknown>;
    expect(asMeta.issuer).toBe(gw.jcIssuer);
    expect(asMeta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asMeta.authorization_response_iss_parameter_supported).toBe(true);
    expect(Array.isArray(asMeta.dpop_signing_alg_values_supported)).toBe(true);
    expect(asMeta.dpop_signing_alg_values_supported).toContain("EdDSA");

    // Loopback IPv4 & IPv6 redirects are accepted on /authorize for jace-commander-cli.
    for (const redirectUri of ["http://127.0.0.1:49152/callback", "http://[::1]:49153/callback"]) {
      const { challenge } = generatePkce();
      const authRes = await fetch(
        gw.authorizeUrl({
          client_id: "jace-commander-cli",
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256"
        }),
        { redirect: "manual" }
      );
      expect(authRes.status).toBe(200);
    }

    // Complete consent -> token exchange with DPoP proof.
    const state = randomBytes(16).toString("base64url");
    const { verifier, challenge } = generatePkce();
    const redirectUri = "http://127.0.0.1:49152/callback";
    const consentRes = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        oauth_lane: "jc",
        client_id: "jace-commander-cli",
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "mcp",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: gw.jcResource,
        passphrase: gw.consentPassphrase,
        dpop_jkt: key.jkt
      }).toString()
    });
    expect(consentRes.status).toBe(302);
    const callbackUrl = new URL(consentRes.headers.get("location") ?? "");
    expect(callbackUrl.searchParams.get("state")).toBe(state);
    expect(callbackUrl.searchParams.get("iss")).toBe(gw.jcIssuer);
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await gw.postTokenWithDpop(
      {
        grant_type: "authorization_code",
        code: code!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: "jace-commander-cli"
      },
      key
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(tokenBody.token_type).toBe("DPoP");
    expect(tokenBody.expires_in).toBe(600);
    expect(tokenBody.refresh_token).toBeTruthy();

    const { payload } = decodeJwtUnverified(tokenBody.access_token);
    expect(payload.iss).toBe(gw.jcIssuer);
    expect(payload.aud).toBe(gw.jcResource);
    expect(payload.client_id).toBe("jace-commander-cli");
    expect((payload.cnf as { jkt?: string } | undefined)?.jkt).toBe(key.jkt);
  });

  it("SEC-02: PKCE S256 enforced on /authorize, /authorize/consent, and /token; wrong verifier burns code", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();
    const redirectUri = "http://127.0.0.1:49154/callback";
    const { challenge } = generatePkce();

    // /authorize rejects missing or plain PKCE
    const missingAuth = await fetch(
      gw.authorizeUrl({
        client_id: "jace-commander-cli",
        redirect_uri: redirectUri
      }),
      { redirect: "manual" }
    );
    expect(missingAuth.status).toBe(302);
    expect(new URL(missingAuth.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

    const plainAuth = await fetch(
      gw.authorizeUrl({
        client_id: "jace-commander-cli",
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "plain"
      }),
      { redirect: "manual" }
    );
    expect(plainAuth.status).toBe(302);
    expect(new URL(plainAuth.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

    // /authorize/consent rejects plain/malformed/missing PKCE
    for (const overrides of [
      { code_challenge: "", code_challenge_method: "" },
      { code_challenge: challenge, code_challenge_method: "plain" },
      { code_challenge: "too-short", code_challenge_method: "S256" }
    ]) {
      const badConsent = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        redirect: "manual",
        body: new URLSearchParams({
          oauth_lane: "jc",
          client_id: "jace-commander-cli",
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "mcp",
          state: "s1",
          resource: gw.jcResource,
          passphrase: gw.consentPassphrase,
          ...overrides
        }).toString()
      });
      expect(badConsent.status).toBe(400);
    }

    // Issue real code, attempt wrong verifier -> 400 invalid_grant, and code is burned
    const { verifier: realVerifier, challenge: realChallenge } = generatePkce();
    const consentOk = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        oauth_lane: "jc",
        client_id: "jace-commander-cli",
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "mcp",
        state: "s-burn",
        code_challenge: realChallenge,
        code_challenge_method: "S256",
        resource: gw.jcResource,
        passphrase: gw.consentPassphrase
      }).toString()
    });
    expect(consentOk.status).toBe(302);
    const code = new URL(consentOk.headers.get("location")!).searchParams.get("code")!;

    const wrongRes = await gw.postTokenWithDpop(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier-0123456789abcdefghijklmnopqrstuvwxyz",
        redirect_uri: redirectUri,
        client_id: "jace-commander-cli"
      },
      key
    );
    expect(wrongRes.status).toBe(400);
    expect(((await wrongRes.json()) as { error: string }).error).toBe("invalid_grant");

    // Even with the real verifier afterwards, the burned code MUST fail
    const retryReal = await gw.postTokenWithDpop(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: realVerifier,
        redirect_uri: redirectUri,
        client_id: "jace-commander-cli"
      },
      key
    );
    expect(retryReal.status).toBe(400);
    expect(((await retryReal.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("SEC-03: state preservation and RFC 9207 iss enforcement; missing/mismatched state or iss rejected by CLI callback", async () => {
    const gw = await startJc();
    const redirectUri = "http://127.0.0.1:49155/callback";
    const { challenge } = generatePkce();
    const state = "csrf-state-token-987654321";

    // Server requires non-empty state for jace-commander-cli or preserves state + iss
    const consentRes = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        oauth_lane: "jc",
        client_id: "jace-commander-cli",
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "mcp",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: gw.jcResource,
        passphrase: gw.consentPassphrase
      }).toString()
    });
    expect(consentRes.status).toBe(302);
    const loc = new URL(consentRes.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe(state);
    expect(loc.searchParams.get("iss")).toBe(gw.jcIssuer);

    // Also verify CLI `connect()` rejects forged/mismatched `iss` and `state` on loopback callback
    const mcpAuth = await import("../../apps/jace-commander/src/mcp-auth.js");
    for (const tamper of ["bad_state", "bad_iss", "missing_iss"] as const) {
      let authorizeCaptured = "";
      const connectPromise = mcpAuth.connect({
        mcpUrl: gw.jcResource,
        stateDir: `${gw.dataDir}-cli-${tamper}`,
        timeoutMs: 5000,
        onAuthorizeUrl: (url: string) => {
          authorizeCaptured = url;
          void (async () => {
            const authUrl = new URL(authorizeCaptured);
            const cb = new URL(authUrl.searchParams.get("redirect_uri")!);
            cb.searchParams.set("code", "fake-code");
            cb.searchParams.set("state", tamper === "bad_state" ? "forged-state" : authUrl.searchParams.get("state")!);
            if (tamper === "bad_iss") cb.searchParams.set("iss", "https://evil.example/jc");
            else if (tamper !== "missing_iss") cb.searchParams.set("iss", gw.jcIssuer);
            await fetch(cb.toString());
          })();
        }
      });
      await expect(connectPromise).rejects.toThrow();
    }
  });

  it("SEC-04: RFC 8252 loopback redirect validation blocks non-loopback, wrong path, fragments, userinfo, and token redirect mismatch", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();
    const { verifier, challenge } = generatePkce();

    // Non-loopback, wrong path, fragment, userinfo must be refused at /authorize
    for (const badRedirect of [
      "https://evil.example/callback",
      "http://evil.example/callback",
      "http://127.0.0.1:49152/other-path",
      "http://127.0.0.1:49152/callback#frag",
      "http://user:pass@127.0.0.1:49152/callback"
    ]) {
      const res = await fetch(
        gw.authorizeUrl({
          client_id: "jace-commander-cli",
          redirect_uri: badRedirect,
          code_challenge: challenge,
          code_challenge_method: "S256"
        }),
        { redirect: "manual" }
      );
      expect(res.status).toBe(400);
    }

    // Redirect mismatch at /token (even on a different loopback port) must fail
    const registeredCallback = "http://127.0.0.1:49156/callback";
    const consent = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        oauth_lane: "jc",
        client_id: "jace-commander-cli",
        redirect_uri: registeredCallback,
        response_type: "code",
        scope: "mcp",
        state: "s-redir",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: gw.jcResource,
        passphrase: gw.consentPassphrase
      }).toString()
    });
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;

    const mismatchToken = await gw.postTokenWithDpop(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:49999/callback",
        client_id: "jace-commander-cli"
      },
      key
    );
    expect(mismatchToken.status).toBe(400);
    expect(((await mismatchToken.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("SEC-05: wrong audience/resource rejected across /jc/mcp, /mcp, and ACS gateway", async () => {
    const gw = await startJc();
    const acs = await startAcs();
    const key = generateEd25519DpopKey();

    // Issue a /jc/mcp token
    const jcTokens = await issueBrowserDpopTokens(gw, key);

    // Presenting /jc/mcp token to /mcp (wrong audience & wrong issuer) MUST fail with 401
    const wrongLaneRes = await gw.callMcpWithDpop(jcTokens.accessToken, key, { path: "/mcp" });
    expect(wrongLaneRes.status).toBe(401);

    // Presenting /jc/mcp token to ACS gateway MUST fail with 401
    const acsWithJcToken = await fetch(`${acs.url}/api/work-items`, {
      headers: { authorization: `Bearer ${jcTokens.accessToken}` }
    });
    expect(acsWithJcToken.status).toBe(401);

    // Requesting /authorize on jc lane with DC resource or evil resource MUST fail
    const { challenge } = generatePkce();
    const badResAuth = await fetch(
      gw.authorizeUrl({
        client_id: "jace-commander-cli",
        redirect_uri: "http://127.0.0.1:49157/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: gw.dcResource
      }),
      { redirect: "manual" }
    );
    expect(badResAuth.status).toBe(302);
    expect(new URL(badResAuth.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("SEC-06: wrong scope, wrong consent passphrase, and non-privileged identity separation", async () => {
    const gw = await startJc();
    const redirectUri = "http://127.0.0.1:49158/callback";
    const { challenge } = generatePkce();

    // Privileged ACS/admin scopes requested on /jc MUST fail (invalid_scope)
    const privScopeRes = await fetch(
      gw.authorizeUrl({
        client_id: "jace-commander-cli",
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "acs:admin acs:work:approve"
      }),
      { redirect: "manual" }
    );
    expect(privScopeRes.status).toBe(302);
    expect(new URL(privScopeRes.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");

    // Wrong consent passphrase MUST fail 401 and never redirect with code
    const wrongPassRes = await fetch(`${gw.baseUrl}/authorize/consent?oauth_lane=jc`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        oauth_lane: "jc",
        client_id: "jace-commander-cli",
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "mcp",
        state: "s-bad-pass",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: gw.jcResource,
        passphrase: "definitely-wrong-passphrase"
      }).toString()
    });
    expect(wrongPassRes.status).toBe(401);
    expect(wrongPassRes.headers.get("location")).toBeNull();
  });
});
