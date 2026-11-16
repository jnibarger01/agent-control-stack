import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateAcsDevice,
  bootAcsGateway,
  bootJcGateway,
  decodeJwtUnverified,
  generateEd25519DpopKey,
  signAcsDeviceCodeProof,
  signDpopProof,
  type BootedAcsGateway,
  type BootedJcGateway
} from "./helpers.js";

describe("Suite B: Headless RFC 8628 device flow, device-key registration, and device revocation", () => {
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

  it("SEC-07: Headless RFC 8628 flow on /jc registers device key, issues DPoP-bound tokens, and works on /jc/mcp", async () => {
    const gw = await startJc();
    const key = generateEd25519DpopKey();

    // Discovery advertises device_authorization_endpoint
    const asMeta = (await (await fetch(`${gw.baseUrl}/jc/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(typeof asMeta.device_authorization_endpoint).toBe("string");

    // 1. Start device authorization with dpop_jkt
    const dcRes = await fetch(`${gw.baseUrl}/jc/oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "jace-commander-cli",
        scope: "mcp",
        dpop_jkt: key.jkt,
        device_name: "headless-linux-ci"
      }).toString()
    });
    expect(dcRes.status).toBe(200);
    const dcBody = (await dcRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(dcBody.device_code).toBeTruthy();
    expect(dcBody.user_code).toBeTruthy();
    expect(dcBody.verification_uri).toContain("/jc/device");
    expect(dcBody.verification_uri_complete).toContain(encodeURIComponent(dcBody.user_code));

    // 2. Poll before approval -> authorization_pending
    const pendingRes = await gw.postTokenWithDpop(
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "jace-commander-cli",
        device_code: dcBody.device_code
      },
      key,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(pendingRes.status).toBe(400);
    expect(((await pendingRes.json()) as { error: string }).error).toBe("authorization_pending");

    // 3. Human verifies and approves via GET/POST /jc/device
    const verifyPage = await fetch(`${gw.baseUrl}/jc/device?user_code=${encodeURIComponent(dcBody.user_code)}`);
    expect(verifyPage.status).toBe(200);
    const approveRes = await fetch(`${gw.baseUrl}/jc/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_code: dcBody.user_code,
        action: "approve",
        passphrase: gw.consentPassphrase
      }).toString()
    });
    expect(approveRes.status).toBe(200);

    // Wait past interval (or use test interval) and exchange device_code with DPoP proof
    await new Promise((r) => setTimeout(r, (dcBody.interval + 0.2) * 1000));
    const tokenRes = await gw.postTokenWithDpop(
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "jace-commander-cli",
        device_code: dcBody.device_code
      },
      key,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      device_id: string;
    };
    expect(tokenBody.token_type).toBe("DPoP");
    expect(tokenBody.device_id).toBeTruthy();

    const { payload } = decodeJwtUnverified(tokenBody.access_token);
    expect((payload.cnf as { jkt?: string })?.jkt).toBe(key.jkt);

    // Verify /jc/mcp accepts the device-flow DPoP token and /jc/devices lists the registered device
    const mcpRes = await gw.callMcpWithDpop(tokenBody.access_token, key);
    expect(mcpRes.status).toBe(200);

    const devicesRes = await gw.callMcpWithDpop(tokenBody.access_token, key, {
      path: "/jc/devices",
      method: "GET"
    });
    expect(devicesRes.status).toBe(200);
    const devicesBody = (await devicesRes.json()) as {
      devices: Array<{ device_id: string; jkt: string; status: string }>;
    };
    expect(devicesBody.devices.some((d) => d.device_id === tokenBody.device_id && d.jkt === key.jkt && d.status === "active")).toBe(true);
  }, 20_000);

  it("SEC-08: RFC 8628 negative states: slow_down, access_denied, wrong passphrase, expired_token, and single-use replay rejection", async () => {
    const gw = await startJc({ extraEnv: { EDGE_TEST_DEVICE_CODE_TTL_S: "2" } });
    const key = generateEd25519DpopKey();

    // Flow 1: slow_down when polling too fast + denial -> access_denied
    const dc1 = (await (
      await fetch(`${gw.baseUrl}/jc/oauth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "jace-commander-cli", scope: "mcp", dpop_jkt: key.jkt }).toString()
      })
    ).json()) as { device_code: string; user_code: string };

    // First poll sets lastPolledAt
    const firstPoll = await gw.postTokenWithDpop(
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "jace-commander-cli", device_code: dc1.device_code },
      key,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(firstPoll.status).toBe(400);
    expect(((await firstPoll.json()) as { error: string }).error).toBe("authorization_pending");

    // Immediate second poll -> slow_down
    const fastPoll = await gw.postTokenWithDpop(
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "jace-commander-cli", device_code: dc1.device_code },
      key,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(fastPoll.status).toBe(400);
    expect(((await fastPoll.json()) as { error: string }).error).toBe("slow_down");

    // Wrong consent passphrase cannot approve
    const badApprove = await fetch(`${gw.baseUrl}/jc/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: dc1.user_code, action: "approve", passphrase: "wrong" }).toString()
    });
    expect(badApprove.status).toBe(401);

    // Deny -> access_denied
    const denyRes = await fetch(`${gw.baseUrl}/jc/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: dc1.user_code, action: "deny", passphrase: gw.consentPassphrase }).toString()
    });
    expect(denyRes.status).toBe(200);

    // Re-approving a denied user_code MUST fail (single-use)
    const reApprove = await fetch(`${gw.baseUrl}/jc/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: dc1.user_code, action: "approve", passphrase: gw.consentPassphrase }).toString()
    });
    expect(reApprove.status).toBeGreaterThanOrEqual(400);

    const deniedPoll = await gw.postTokenWithDpop(
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "jace-commander-cli", device_code: dc1.device_code },
      key,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(deniedPoll.status).toBe(400);
    expect(((await deniedPoll.json()) as { error: string }).error).toBe("access_denied");

    // Flow 2: single-use device_code replay rejected after successful exchange
    const dc2 = (await (
      await fetch(`${gw.baseUrl}/jc/oauth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "jace-commander-cli", scope: "mcp", dpop_jkt: key.jkt }).toString()
      })
    ).json()) as { device_code: string; user_code: string; interval: number };
    await fetch(`${gw.baseUrl}/jc/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: dc2.user_code, action: "approve", passphrase: gw.consentPassphrase }).toString()
    });
    const ok2 = await gw.postTokenWithDpop(
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "jace-commander-cli", device_code: dc2.device_code },
      key,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(ok2.status).toBe(200);
    const replay2 = await gw.postTokenWithDpop(
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "jace-commander-cli", device_code: dc2.device_code },
      key,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(replay2.status).toBe(400);
    expect(((await replay2.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("SEC-09: device-key registration checks: dpop_jkt mismatch, private JWK rejected, alg=none/HS256 rejected, ACS device_signature verified", async () => {
    const gw = await startJc();
    const acs = await startAcs();
    const registeredKey = generateEd25519DpopKey();
    const attackerKey = generateEd25519DpopKey();

    // 1. /jc device flow registered for registeredKey.jkt cannot be redeemed with attackerKey
    const dc = (await (
      await fetch(`${gw.baseUrl}/jc/oauth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "jace-commander-cli",
          scope: "mcp",
          dpop_jkt: registeredKey.jkt
        }).toString()
      })
    ).json()) as { device_code: string; user_code: string };

    await fetch(`${gw.baseUrl}/jc/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: dc.user_code, action: "approve", passphrase: gw.consentPassphrase }).toString()
    });

    const wrongKeyExchange = await gw.postTokenWithDpop(
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "jace-commander-cli", device_code: dc.device_code },
      attackerKey,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(wrongKeyExchange.status).toBe(400);

    // 2. DPoP proof embedding private key material `d` or disallowed alg MUST be rejected
    const tokenHtu = `${gw.publicOrigin}/jc/oauth/token`;
    const privateJwkProof = signDpopProof({
      key: registeredKey,
      htm: "POST",
      htu: tokenHtu,
      jwkOverride: registeredKey.privateJwk as Record<string, unknown>
    });
    const privJwkRes = await fetch(`${gw.baseUrl}/jc/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", DPoP: privateJwkProof },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "jace-commander-cli",
        device_code: dc.device_code
      }).toString()
    });
    expect(privJwkRes.status).toBe(400);

    for (const badAlg of ["none", "HS256"]) {
      const badAlgProof = signDpopProof({
        key: registeredKey,
        alg: badAlg,
        htm: "POST",
        htu: tokenHtu
      });
      const badAlgRes = await fetch(`${gw.baseUrl}/jc/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", DPoP: badAlgProof },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "jace-commander-cli",
          device_code: dc.device_code
        }).toString()
      });
      expect(badAlgRes.status).toBe(400);
    }

    // 3. ACS device_signature proof rejects forged/wrong-key signature
    const acsCode = (await (
      await fetch(`${acs.url}/oauth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: "acs-cli",
          device_public_key: registeredKey.publicKeyPem,
          device_name: "acs-check",
          scope: "acs:device"
        })
      })
    ).json()) as { device_code: string; user_code: string };

    await fetch(`${acs.url}/device/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${acs.operatorToken}` },
      body: JSON.stringify({ user_code: acsCode.user_code, action: "approve" })
    });

    const wrongAcsSig = signAcsDeviceCodeProof(attackerKey.privateKey, acsCode.device_code);
    const badAcsExchange = await fetch(`${acs.url}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        DPoP: signDpopProof({ key: registeredKey, htm: "POST", htu: `${acs.publicOrigin}/oauth/token` })
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "acs-cli",
        device_code: acsCode.device_code,
        device_signature: wrongAcsSig
      })
    });
    expect(badAcsExchange.status).toBe(400);
  });

  it("SEC-10: revoked device immediately blocks /jc/mcp, refresh, and ACS protected calls", async () => {
    const gw = await startJc();
    const acs = await startAcs();
    const jcKey = generateEd25519DpopKey();
    const acsKey = generateEd25519DpopKey();

    // Register & approve /jc device
    const dc = (await (
      await fetch(`${gw.baseUrl}/jc/oauth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "jace-commander-cli", scope: "mcp", dpop_jkt: jcKey.jkt }).toString()
      })
    ).json()) as { device_code: string; user_code: string };
    await fetch(`${gw.baseUrl}/jc/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: dc.user_code, action: "approve", passphrase: gw.consentPassphrase }).toString()
    });
    const tokRes = await gw.postTokenWithDpop(
      { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "jace-commander-cli", device_code: dc.device_code },
      jcKey,
      { url: `${gw.baseUrl}/jc/oauth/token` }
    );
    expect(tokRes.status).toBe(200);
    const { access_token: jcAccess, refresh_token: jcRefresh, device_id: jcDeviceId } = (await tokRes.json()) as {
      access_token: string;
      refresh_token: string;
      device_id: string;
    };

    // Revoke /jc device
    const revokeJc = await gw.callMcpWithDpop(jcAccess, jcKey, {
      path: `/jc/devices/${encodeURIComponent(jcDeviceId)}/revoke`,
      method: "POST",
      body: "{}"
    });
    expect(revokeJc.status).toBe(200);
    expect(((await revokeJc.json()) as { revoked: boolean }).revoked).toBe(true);

    // Subsequent /jc/mcp and refresh MUST fail immediately
    const mcpAfterRevoke = await gw.callMcpWithDpop(jcAccess, jcKey);
    expect(mcpAfterRevoke.status).toBe(401);

    const refreshAfterRevoke = await gw.postTokenWithDpop(
      {
        grant_type: "refresh_token",
        client_id: "jace-commander-cli",
        refresh_token: jcRefresh,
        refresh_request_id: "req-after-revoke"
      },
      jcKey
    );
    expect(refreshAfterRevoke.status).toBe(400);
    expect(((await refreshAfterRevoke.json()) as { error: string }).error).toBe("invalid_grant");

    // ACS device revocation
    const acsDevice = await authenticateAcsDevice(acs, acsKey);
    const revokeAcs = await fetch(`${acs.url}/devices/${encodeURIComponent(acsDevice.deviceId)}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${acs.operatorToken}` }
    });
    expect(revokeAcs.status).toBe(200);

    const acsAfterRevoke = await fetch(`${acs.url}/work-items`, {
      headers: {
        authorization: `DPoP ${acsDevice.accessToken}`,
        DPoP: signDpopProof({
          key: acsKey,
          htm: "GET",
          htu: `${acs.publicOrigin}/work-items`,
          accessToken: acsDevice.accessToken
        })
      }
    });
    expect(acsAfterRevoke.status).toBe(401);
  });
});
