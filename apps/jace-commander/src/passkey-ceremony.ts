/**
 * Human-side WebAuthn ceremony for `jace-commander approve` and `passkey-register` (Jace's decision 2026-10-13).
 *
 * WebAuthn needs a browser (or platform authenticator via the browser), so the CLI serves ONE minimal page
 * on the pinned origin (only http://localhost:<port> is supported; approverd and passkey-register reject any
 * other origin at config load, so no origin is ever accepted without a ceremony), opens nothing by itself, and prints the URL. The page calls navigator.credentials.get()
 * (or .create() for registration) with userVerification 'required' and POSTs the result back. The server
 * accepts exactly one result on an unguessable path, binds to the loopback interface only, and stops at the
 * deadline. Nothing here verifies anything: approverd verifies the assertion; the registration tool verifies
 * the attestation with @simplewebauthn/server.
 */
import crypto from 'node:crypto';
import http from 'node:http';

export type CeremonyMode = 'get' | 'create';

export interface CeremonyRequest {
  mode: CeremonyMode;
  /** Pinned origin, must be http://localhost:<port>. */
  origin: string;
  /** PublicKeyCredentialRequestOptionsJSON (get) or PublicKeyCredentialCreationOptionsJSON (create). */
  options: Record<string, unknown>;
  timeoutMs: number;
  /** Called with the URL the human must open on this machine. */
  onUrl(url: string): void;
  /** Short human-readable context shown on the page (never secrets). */
  summary?: string;
}

function page(mode: CeremonyMode, options: Record<string, unknown>, resultPath: string, summary: string): string {
  const data = JSON.stringify({ mode, options, resultPath, summary }).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Jace Commander passkey</title>
<body style="font-family:system-ui;max-width:40em;margin:3em auto">
<h1>Jace Commander passkey ${mode === 'get' ? 'approval' : 'registration'}</h1><pre id="s"></pre>
<button id="go">Use passkey</button><p id="out"></p>
<script>
const D = ${data};
document.getElementById('s').textContent = D.summary;
const b2u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const u2b = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
document.getElementById('go').onclick = async () => {
  const out = document.getElementById('out');
  try {
    const o = D.options; let body;
    if (D.mode === 'get') {
      const c = await navigator.credentials.get({ publicKey: { challenge: u2b(o.challenge), rpId: o.rpId, timeout: o.timeout,
        userVerification: 'required', allowCredentials: (o.allowCredentials || []).map(a => ({ type: 'public-key', id: u2b(a.id), transports: a.transports })) } });
      body = { id: c.id, rawId: b2u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined,
        response: { clientDataJSON: b2u(c.response.clientDataJSON), authenticatorData: b2u(c.response.authenticatorData), signature: b2u(c.response.signature),
          userHandle: c.response.userHandle ? b2u(c.response.userHandle) : undefined } };
    } else {
      const c = await navigator.credentials.create({ publicKey: { ...o, challenge: u2b(o.challenge), user: { ...o.user, id: u2b(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map(a => ({ ...a, id: u2b(a.id) })) } });
      body = { id: c.id, rawId: b2u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined,
        response: { clientDataJSON: b2u(c.response.clientDataJSON), attestationObject: b2u(c.response.attestationObject),
          transports: c.response.getTransports ? c.response.getTransports() : [] } };
    }
    const r = await fetch(D.resultPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    out.textContent = r.ok ? 'Done. Return to the terminal.' : 'The terminal refused the result.';
  } catch (e) { out.textContent = 'Cancelled or failed: ' + e.name; }
};
</script>`;
}

/** Validates that a ceremony can run locally on this origin and returns its port. */
export function localCeremonyPort(origin: string): number {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || !url.port || url.origin !== origin) {
    throw new Error(`the local passkey page supports only http://localhost:<port> origins (got ${origin})`);
  }
  return Number(url.port);
}

/** Serves the page once and resolves with the posted credential JSON. */
export function runLocalCeremony(request: CeremonyRequest): Promise<Record<string, unknown>> {
  const port = localCeremonyPort(request.origin);
  const token = crypto.randomBytes(24).toString('base64url');
  const pagePath = `/${token}`;
  const resultPath = `/${token}/result`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-frame-options', 'DENY');
      if (req.method === 'GET' && req.url === pagePath) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
        res.end(page(request.mode, request.options, resultPath, request.summary ?? ''));
        return;
      }
      if (req.method === 'POST' && req.url === resultPath && !settled && req.headers.origin === request.origin) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
            res.end('ok');
            finish(() => resolve(parsed));
          } catch {
            res.statusCode = 400;
            res.end('bad request');
          }
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const timer = setTimeout(() => finish(() => reject(new Error('passkey ceremony timed out'))), request.timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      fn();
    };
    server.once('error', (error) => finish(() => reject(new Error(`cannot serve the passkey page on ${request.origin} (${(error as NodeJS.ErrnoException).code ?? 'error'})`))));
    server.listen(port, '127.0.0.1', () => request.onUrl(`${request.origin}${pagePath}`));
  });
}
