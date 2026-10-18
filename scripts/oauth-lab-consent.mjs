#!/usr/bin/env node
/**
 * Completes the consent step of the disposable OAuth lab for a real MCP client that is waiting on a loopback callback.
 *   node scripts/oauth-lab-consent.mjs '<authorize URL printed by the client>' '<lab consent passphrase>' [--print]
 *   --print only prints the redirect URL (for clients that ask you to paste it back) instead of delivering the code.
 * It plays the human at the consent page of the LAB edge only (the passphrase is the lab's throwaway one), then delivers the
 * authorization code to the client's own redirect URI. Refuses any non-loopback authorize URL.
 */
const [authorizeUrl, passphrase, mode] = process.argv.slice(2);
if (!authorizeUrl || !passphrase) { console.error('usage: oauth-lab-consent.mjs <authorize-url> <passphrase>'); process.exit(2); }
const url = new URL(authorizeUrl);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { console.error('refusing: lab consent only works against a loopback edge'); process.exit(2); }
const page = await fetch(url);
const html = await page.text();
if (page.status !== 200) { console.error(`authorize failed: HTTP ${page.status}`); process.exit(1); }
const fields = {};
for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
  fields[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const consent = await fetch(new URL('/authorize/consent', url.origin), {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...fields, passphrase }).toString(),
});
const location = consent.headers.get('location');
if (consent.status !== 302 || !location) { console.error(`consent failed: HTTP ${consent.status}`); process.exit(1); }
if (mode === '--print') { console.log(location); process.exit(0); }
const callback = new URL(location);
console.log(`client_id=${fields.client_id} redirect=${callback.origin}${callback.pathname}`);
if (!['127.0.0.1', 'localhost'].includes(callback.hostname)) { console.log('redirect is not loopback; open it yourself:', location); process.exit(0); }
const done = await fetch(callback).catch((e) => ({ status: `error ${e.message}` }));
console.log(`delivered code to client callback: ${done.status}`);
