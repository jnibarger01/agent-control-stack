// RFC 8628 device authorization HTTP surface. See docs/adr/0015-public-oauth-device-authorization.md.
//
// This module owns the wire protocol only; all persistence and state-machine logic lives
// in ./device-auth-store.ts. Human authentication for /device/verify is NOT reimplemented
// here - it reuses the gateway's existing Mission Control session (gatewayCredentialForRequest
// / renderLoginPage), the only human-auth mechanism ACS has.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  DEFAULT_DEVICE_AUTH_CLIENT_ID,
  DeviceAuthStore,
  type DeviceAuthorizationSummary
} from "./device-auth-store.js";
import {
  gatewayCredentialCanMutate,
  gatewayCredentialForRequest,
  renderLoginPage,
  type GatewayAuthOptions
} from "./server.js";

export interface DeviceAuthRouteOptions {
  store: DeviceAuthStore;
  auth: GatewayAuthOptions | undefined;
  allowedClientIds?: readonly string[];
  publicOriginOverride?: string;
}

const DEFAULT_REQUESTED_SCOPES = ["acs:device"];

export function registerDeviceAuthRoutes(app: FastifyInstance, options: DeviceAuthRouteOptions): void {
  const allowedClientIds = options.allowedClientIds ?? [DEFAULT_DEVICE_AUTH_CLIENT_ID];

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.post("/oauth/device/code", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const clientId = stringField(body.client_id);
    const devicePublicKeyPem = stringField(body.device_public_key);
    const deviceName = stringField(body.device_name) ?? "unnamed-device";
    const scopes = stringField(body.scope)?.split(/\s+/).filter(Boolean) ?? DEFAULT_REQUESTED_SCOPES;

    if (!clientId || !devicePublicKeyPem) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = options.store.requestDeviceCode(
      { clientId, requestedScopes: scopes, devicePublicKeyPem, deviceName },
      allowedClientIds
    );
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }
    const origin = publicOrigin(request, options.publicOriginOverride);
    const verificationUri = `${origin}/device/verify`;
    return reply.code(200).send({
      device_code: result.deviceCode,
      user_code: result.userCodeFormatted,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(result.userCodeFormatted)}`,
      expires_in: result.expiresIn,
      interval: result.interval
    });
  });

  app.post("/oauth/token", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const grantType = stringField(body.grant_type);
    const clientId = stringField(body.client_id);
    if (!clientId) {
      return reply.code(400).send({ error: "invalid_client" });
    }
    if (!allowedClientIds.includes(clientId)) {
      return reply.code(400).send({ error: "invalid_client" });
    }

    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const deviceCode = stringField(body.device_code);
      if (!deviceCode) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = options.store.pollToken(deviceCode, clientId);
      if (result.status === "success") {
        return reply.code(200).send({
          access_token: result.accessToken,
          token_type: "Bearer",
          expires_in: result.accessTokenExpiresIn,
          refresh_token: result.refreshToken,
          scope: result.scopes.join(" "),
          device_id: result.deviceId,
          principal: result.principalId
        });
      }
      return reply.code(400).send({ error: result.status });
    }

    if (grantType === "refresh_token") {
      const refreshToken = stringField(body.refresh_token);
      if (!refreshToken) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = options.store.refreshAccessToken(refreshToken);
      if (!result.ok) {
        return reply.code(400).send({ error: "invalid_grant" });
      }
      return reply.code(200).send({
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_in: result.accessTokenExpiresIn,
        refresh_token: result.refreshToken,
        scope: result.scopes.join(" "),
        device_id: result.deviceId,
        principal: result.principalId
      });
    }

    return reply.code(400).send({ error: "unsupported_grant_type" });
  });

  app.get("/device/verify", async (request, reply) => {
    const credential = gatewayCredentialForRequest(request, options.auth);
    if (!credential) {
      return reply.code(401).type("text/html").send(renderLoginPage(request.url));
    }
    const userCode = stringField((request.query as Record<string, unknown> | undefined)?.user_code);
    const summary = userCode ? options.store.findByUserCode(userCode) : undefined;
    return reply.type("text/html").send(renderDeviceVerifyPage({ userCode, summary }));
  });

  app.post("/device/verify", async (request, reply) => {
    const credential = gatewayCredentialForRequest(request, options.auth);
    if (!credential) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!credential.actorId) {
      return reply.code(503).send({ error: "registry actor binding is not configured; set ACS_GATEWAY_ACTOR_ID" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const userCode = stringField(body.user_code);
    const action = stringField(body.action);
    if (!userCode || (action !== "approve" && action !== "deny")) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result =
      action === "approve" ? options.store.approve(userCode, credential.actorId) : options.store.deny(userCode);
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : result.error === "expired" ? 410 : 409;
      return reply.code(status).send({ error: result.error });
    }
    return reply.code(200).send({ ok: true });
  });

  // Remote device revocation, independent of any CLI-side logout. Operator-only:
  // this is the same mutation privilege gate used elsewhere (POST /connectors, etc.),
  // not a new authorization concept.
  app.post<{ Params: { id: string } }>("/devices/:id/revoke", async (request, reply) => {
    const credential = gatewayCredentialForRequest(request, options.auth);
    if (!credential || !gatewayCredentialCanMutate(credential)) {
      return reply.code(credential ? 403 : 401).send({ error: credential ? "forbidden" : "unauthorized" });
    }
    const revoked = options.store.revokeDevice(request.params.id);
    if (!revoked) {
      return reply.code(404).send({ error: "device_not_found" });
    }
    return reply.code(200).send({ ok: true });
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function publicOrigin(request: FastifyRequest, override: string | undefined): string {
  if (override) return override.replace(/\/+$/, "");
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? request.protocol;
  const host = firstHeader(request.headers["x-forwarded-host"]) ?? request.headers.host;
  return host ? `${proto}://${host}` : "http://127.0.0.1";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function renderDeviceVerifyPage(input: {
  userCode: string | undefined;
  summary: DeviceAuthorizationSummary | undefined;
}): string {
  const escapedUserCode = input.userCode ? escapeHtml(input.userCode) : "";
  if (input.userCode && !input.summary) {
    return devicePage(
      `<p class="error">That code is invalid, expired, or already used. Ask the CLI to run <code>acs auth login</code> again.</p>`
    );
  }
  if (!input.summary) {
    return devicePage(`
      <form id="lookup-form">
        <label>Device code<input name="user_code" placeholder="XXXX-XXXX" autocomplete="off" autofocus /></label>
        <button type="submit">Continue</button>
      </form>
      <script>
        document.querySelector('#lookup-form').addEventListener('submit', (event) => {
          event.preventDefault();
          const code = new FormData(event.currentTarget).get('user_code');
          location.assign('/device/verify?user_code=' + encodeURIComponent(String(code || '')));
        });
      </script>`);
  }
  const summary = input.summary;
  if (summary.status !== "pending") {
    return devicePage(`<p class="error">This device request is ${escapeHtml(summary.status)}, not pending.</p>`);
  }
  return devicePage(`
    <h2>Approve this device?</h2>
    <dl>
      <dt>Device</dt><dd>${escapeHtml(summary.deviceName)}</dd>
      <dt>Public key fingerprint</dt><dd><code>${escapeHtml(summary.devicePublicKeyFingerprint)}</code></dd>
      <dt>Requested scopes</dt><dd>${escapeHtml(summary.requestedScopes.join(", "))}</dd>
    </dl>
    <div class="actions">
      <button id="approve" class="approve">Approve</button>
      <button id="deny" class="deny">Deny</button>
    </div>
    <output></output>
    <script>
      const userCode = ${JSON.stringify(escapedUserCode)};
      async function act(action) {
        const res = await fetch('/device/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user_code: userCode, action })
        });
        document.querySelector('output').textContent = res.ok
          ? (action === 'approve' ? 'Device approved. You can close this tab.' : 'Device denied.')
          : 'That request could not be completed (it may have expired or already been used).';
        document.querySelectorAll('.actions button').forEach((button) => { button.disabled = true; });
      }
      document.querySelector('#approve').addEventListener('click', () => act('approve'));
      document.querySelector('#deny').addEventListener('click', () => act('deny'));
    </script>`);
}

function devicePage(body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentOS Mission Control - Device Authorization</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #071019; color: #d7e0ea; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #071019; }
      main { width: min(420px, calc(100vw - 32px)); display: grid; gap: 12px; border: 1px solid #17283a; background: #0a1522; padding: 20px; border-radius: 8px; }
      h2 { margin: 0 0 4px; font-size: 20px; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
      dt { color: #91a6bd; font-size: 13px; }
      dd { margin: 0; font-size: 14px; }
      code { background: #07111d; padding: 2px 6px; border-radius: 4px; }
      .actions { display: flex; gap: 10px; }
      button { border: 0; border-radius: 8px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
      .approve { background: #16a34a; color: white; }
      .deny { background: #dc2626; color: white; }
      .error { color: #fca5a5; }
      input { background: #07111d; color: #dbeafe; border: 1px solid #1c3148; border-radius: 8px; padding: 10px; width: 100%; box-sizing: border-box; }
      label { display: grid; gap: 6px; color: #91a6bd; font-size: 13px; }
      output { min-height: 20px; }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!
  );
}
