import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateAcsDevice,
  bootAcsGateway,
  bootJcGateway,
  generateEd25519DpopKey,
  generateEs256DpopKey,
  issueBrowserDpopTokens,
  sha256B64u,
  signDpopProof,
  type BootedAcsGateway,
  type BootedJcGateway
} from "./helpers.js";

describe("Suite C: RFC 9449 DPoP issuance, ath/htm/htu/iat/jti/nonce checks, restart replay, stolen-token, and no Bearer downgrade", () => {
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

  async function startAcs(options = {}): Promise<BootedAcsGateway> {
    const acs = await bootAcsGateway(options);
    cleanups.push(() => acs.close());
    return acs;
  }

  it("SEC-11: DPoP issuance & verification succeeds for EdDSA and ES256 on /jc/mcp and ACS", async () => {
    const gw = await startJc();
    const acs = await startAcs();

    // EdDSA on /jc/mcp
    const edKey = generateEd25519DpopKey();
    const edTokens = await issueBrowserDpopTokens(gw, edKey);
    const edRes = await gw.callMcpWithDpop(edTokens.accessToken, edKey);
    expect(edRes.status).toBe(200);

    // ES256 on /jc/mcp
    const esKey = generateEs256DpopKey();
    const esTokens = await issueBrowserDpopTokens(gw, esKey);
    const esRes = await gw.callMcpWithDpop(esTokens.accessToken, esKey);
    expect(esRes.status).toBe(200);

    // EdDSA on ACS protected endpoint
    const acsKey = generateEd25519DpopKey();
    const acsDev = await authenticateAcsDevice(acs, acsKey);
    const acsRes = await fetch(`${acs.url}/work-items`, {
      headers: {
        authorization: `DPoP ${acsDev.accessToken}`,
        DPoP: signDpopProof({
          key: acsKey,
          htm: "GET",
          htu: `${acs.publicOrigin}/work-items`,
          accessToken: acsDev.accessToken
        })
      }
    });
    expect(acsRes.status).toBe(200);
  });

  it("SEC-12: rejects missing, wrong, or foreign-token ath on /jc/mcp and ACS", async () => {
    const gw = await startJc({ dpopNonceRequired: false });
    const acs = await startAcs();
    const key = generateEd25519DpopKey();
    const { accessToken } = await issueBrowserDpopTokens(gw, key);

    for (const ath of [undefined, sha256B64u("wrong-access-token"), "not-a-valid-sha256"]) {
      const proof = signDpopProof({
        key,
        htm: "POST",
        htu: `${gw.publicOrigin}/jc/mcp`,
        ...(ath !== undefined ? { ath } : {})
      });
      const res = await fetch(`${gw.baseUrl}/jc/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${accessToken}`,
          DPoP: proof
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });
      expect(res.status).toBe(401);
    }

    const acsDev = await authenticateAcsDevice(acs, key);
    const acsBadAth = await fetch(`${acs.url}/work-items`, {
      headers: {
        authorization: `DPoP ${acsDev.accessToken}`,
        DPoP: signDpopProof({
          key,
          htm: "GET",
          htu: `${acs.publicOrigin}/work-items`,
          ath: sha256B64u("other-token")
        })
      }
    });
    expect(acsBadAth.status).toBe(401);
  });

  it("SEC-13: rejects DPoP htm mismatch (GET vs POST, lowercase method)", async () => {
    const gw = await startJc({ dpopNonceRequired: false });
    const key = generateEd25519DpopKey();
    const { accessToken } = await issueBrowserDpopTokens(gw, key);

    for (const htm of ["GET", "DELETE", "post"]) {
      const proof = signDpopProof({
        key,
        htm,
        htu: `${gw.publicOrigin}/jc/mcp`,
        accessToken
      });
      const res = await fetch(`${gw.baseUrl}/jc/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${accessToken}`,
          DPoP: proof
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });
      expect(res.status).toBe(401);
    }
  });

  it("SEC-14: rejects DPoP htu mismatch and ignores spoofed Host / X-Forwarded-* headers", async () => {
    const gw = await startJc({ publicOrigin: "https://canonical.example.test", dpopNonceRequired: false });
    const acs = await startAcs({ publicOrigin: "https://acs.canonical.test" });
    const key = generateEd25519DpopKey();
    const { accessToken } = await issueBrowserDpopTokens(gw, key);

    // Wrong path, query string, or attacker origin MUST fail even with spoofed Host / X-Forwarded-* headers
    for (const badHtu of [
      "https://canonical.example.test/mcp",
      "https://canonical.example.test/jc/mcp?foo=bar",
      "https://canonical.example.test/jc/mcp#frag",
      "https://attacker.evil.test/jc/mcp",
      "http://canonical.example.test/jc/mcp"
    ]) {
      const proof = signDpopProof({
        key,
        htm: "POST",
        htu: badHtu,
        accessToken
      });
      const res = await fetch(`${gw.baseUrl}/jc/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${accessToken}`,
          DPoP: proof,
          host: "attacker.evil.test",
          "x-forwarded-host": "attacker.evil.test",
          "x-forwarded-proto": "http",
          forwarded: "host=attacker.evil.test;proto=http"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });
      expect(res.status).toBe(401);
    }

    // ACS gateway MUST also ignore spoofed Host / X-Forwarded-Host / X-Forwarded-Proto
    const acsDev = await authenticateAcsDevice(acs, key);
    const spoofedAcs = await fetch(`${acs.url}/work-items`, {
      headers: {
        authorization: `DPoP ${acsDev.accessToken}`,
        DPoP: signDpopProof({
          key,
          htm: "GET",
          htu: "https://attacker.evil.test/work-items",
          accessToken: acsDev.accessToken
        }),
        host: "attacker.evil.test",
        "x-forwarded-host": "attacker.evil.test",
        "x-forwarded-proto": "https"
      }
    });
    expect(spoofedAcs.status).toBe(401);
  });

  it("SEC-15: rejects expired and far-future DPoP iat timestamps", async () => {
    const gw = await startJc({ dpopNonceRequired: false });
    const key = generateEd25519DpopKey();
    const { accessToken } = await issueBrowserDpopTokens(gw, key);
    const nowSec = Math.floor(Date.now() / 1000);

    for (const iat of [nowSec - 120, nowSec + 120]) {
      const proof = signDpopProof({
        key,
        htm: "POST",
        htu: `${gw.publicOrigin}/jc/mcp`,
        accessToken,
        iat
      });
      const res = await fetch(`${gw.baseUrl}/jc/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${accessToken}`,
          DPoP: proof
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });
      expect(res.status).toBe(401);
    }
  });

  it("SEC-16: rejects DPoP jti replay within same gateway process (/jc/mcp and ACS)", async () => {
    const gw = await startJc({ dpopNonceRequired: false });
    const acs = await startAcs();
    const key = generateEd25519DpopKey();
    const { accessToken } = await issueBrowserDpopTokens(gw, key);

    const proof = signDpopProof({
      key,
      htm: "POST",
      htu: `${gw.publicOrigin}/jc/mcp`,
      accessToken,
      jti: "fixed-jti-replay-check-0001"
    });
    const first = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        DPoP: proof
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(first.status).toBe(200);

    const replay = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        DPoP: proof
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    expect(replay.status).toBe(401);

    // Same on ACS protected endpoint
    const acsDev = await authenticateAcsDevice(acs, key);
    const acsProof = signDpopProof({
      key,
      htm: "GET",
      htu: `${acs.publicOrigin}/work-items`,
      accessToken: acsDev.accessToken,
      jti: "acs-fixed-jti-replay-0001"
    });
    const acsFirst = await fetch(`${acs.url}/work-items`, {
      headers: { authorization: `DPoP ${acsDev.accessToken}`, DPoP: acsProof }
    });
    expect(acsFirst.status).toBe(200);
    const acsReplay = await fetch(`${acs.url}/work-items`, {
      headers: { authorization: `DPoP ${acsDev.accessToken}`, DPoP: acsProof }
    });
    expect(acsReplay.status).toBe(401);
  });

  it("SEC-17: rejects DPoP jti replay across gateway restart (persistent SQLite replay cache)", async () => {
    const gw = await startJc({ dpopNonceRequired: false });
    const acs = await startAcs();
    const key = generateEd25519DpopKey();
    const { accessToken } = await issueBrowserDpopTokens(gw, key);

    const proof = signDpopProof({
      key,
      htm: "POST",
      htu: `${gw.publicOrigin}/jc/mcp`,
      accessToken,
      jti: "restart-persistent-jti-jc-0001"
    });
    const first = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        DPoP: proof
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(first.status).toBe(200);

    // Restart dc-mcp-gateway with same DATA_DIR; replaying the exact proof MUST fail
    await gw.restart();
    const afterRestart = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        DPoP: proof
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    expect(afterRestart.status).toBe(401);

    // Restart ACS gateway with same DB; replaying the exact proof MUST fail
    const acsDev = await authenticateAcsDevice(acs, key);
    const acsProof = signDpopProof({
      key,
      htm: "GET",
      htu: `${acs.publicOrigin}/work-items`,
      accessToken: acsDev.accessToken,
      jti: "restart-persistent-jti-acs-0001"
    });
    const acsFirst = await fetch(`${acs.url}/work-items`, {
      headers: { authorization: `DPoP ${acsDev.accessToken}`, DPoP: acsProof }
    });
    expect(acsFirst.status).toBe(200);

    await acs.restart();
    const acsAfterRestart = await fetch(`${acs.url}/work-items`, {
      headers: { authorization: `DPoP ${acsDev.accessToken}`, DPoP: acsProof }
    });
    expect(acsAfterRestart.status).toBe(401);
  });

  it("SEC-18: enforces DPoP-Nonce challenge (use_dpop_nonce) and rejects forged/stale nonces", async () => {
    const gw = await startJc({ dpopNonceRequired: true });
    const key = generateEd25519DpopKey();
    const { accessToken } = await issueBrowserDpopTokens(gw, key);

    // 1. Missing nonce on /jc/mcp -> 401 + WWW-Authenticate: DPoP error="use_dpop_nonce" + DPoP-Nonce header
    const noNonceProof = signDpopProof({
      key,
      htm: "POST",
      htu: `${gw.publicOrigin}/jc/mcp`,
      accessToken
    });
    const missingNonceRes = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        DPoP: noNonceProof
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(missingNonceRes.status).toBe(401);
    expect(missingNonceRes.headers.get("www-authenticate")).toContain("use_dpop_nonce");
    const freshNonce = missingNonceRes.headers.get("dpop-nonce");
    expect(freshNonce).toBeTruthy();

    // 2. Forged/bogus nonce MUST fail
    const badNonceProof = signDpopProof({
      key,
      htm: "POST",
      htu: `${gw.publicOrigin}/jc/mcp`,
      accessToken,
      nonce: "forged-invalid-nonce-value"
    });
    const badNonceRes = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        DPoP: badNonceProof
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    expect(badNonceRes.status).toBe(401);
    expect(badNonceRes.headers.get("www-authenticate")).toContain("use_dpop_nonce");
    expect(badNonceRes.headers.get("dpop-nonce")).toBeTruthy();

    // 3. Retrying with the server-issued DPoP-Nonce succeeds (note: stub upstream was never touched on rejected calls)
    expect(gw.jcStub.receivedCalls.filter((c) => c.path === "/mcp")).toHaveLength(0);
    const retryProof = signDpopProof({
      key,
      htm: "POST",
      htu: `${gw.publicOrigin}/jc/mcp`,
      accessToken,
      nonce: freshNonce!
    });
    const okRes = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        DPoP: retryProof
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
    });
    expect(okRes.status).toBe(200);
    const nextNonce = okRes.headers.get("dpop-nonce");
    expect(nextNonce).toBeTruthy();

    // 4. Subsequent request using the rotated DPoP-Nonce from the 200 response also succeeds
    const followUpProof = signDpopProof({
      key,
      htm: "POST",
      htu: `${gw.publicOrigin}/jc/mcp`,
      accessToken,
      nonce: nextNonce!
    });
    const followUpRes = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `DPoP ${accessToken}`,
        DPoP: followUpProof
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })
    });
    expect(followUpRes.status).toBe(200);
  });

  it("SEC-19: rejects stolen DPoP access token replayed with an attacker's keypair", async () => {
    const gw = await startJc();
    const acs = await startAcs();
    const victimKey = generateEd25519DpopKey();
    const attackerKey = generateEd25519DpopKey();

    const { accessToken } = await issueBrowserDpopTokens(gw, victimKey);
    const stolenJcRes = await gw.callMcpWithDpop(accessToken, attackerKey);
    expect(stolenJcRes.status).toBe(401);

    const acsDev = await authenticateAcsDevice(acs, victimKey);
    const stolenAcsRes = await fetch(`${acs.url}/work-items`, {
      headers: {
        authorization: `DPoP ${acsDev.accessToken}`,
        DPoP: signDpopProof({
          key: attackerKey,
          htm: "GET",
          htu: `${acs.publicOrigin}/work-items`,
          accessToken: acsDev.accessToken
        })
      }
    });
    expect(stolenAcsRes.status).toBe(401);
  });

  it("SEC-20: rejects Authorization: Bearer for DPoP-bound tokens (no auto Bearer downgrade)", async () => {
    const gw = await startJc();
    const acs = await startAcs();
    const key = generateEd25519DpopKey();

    const { accessToken } = await issueBrowserDpopTokens(gw, key);

    // Sending Bearer <dpop-bound-token> without DPoP MUST fail closed
    const bearerRes = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(bearerRes.status).toBe(401);
    expect(bearerRes.headers.get("www-authenticate")).toMatch(/^DPoP\b/);

    // Sending Bearer <dpop-bound-token> even WITH a valid DPoP header MUST fail closed
    const bearerPlusDpop = await fetch(`${gw.baseUrl}/jc/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        DPoP: signDpopProof({ key, htm: "POST", htu: `${gw.publicOrigin}/jc/mcp`, accessToken })
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    expect(bearerPlusDpop.status).toBe(401);

    // ACS device token sent as Bearer MUST fail closed
    const acsDev = await authenticateAcsDevice(acs, key);
    const acsBearer = await fetch(`${acs.url}/work-items`, {
      headers: { authorization: `Bearer ${acsDev.accessToken}` }
    });
    expect(acsBearer.status).toBe(401);
  });
});
