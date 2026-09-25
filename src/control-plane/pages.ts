import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ServerResponse } from 'node:http';

/**
 * Browser pages. Every page ships a per-response CSP nonce; no inline handlers,
 * no third-party script origins. The consent page loads the supabase-js UMD
 * bundle from this server (<basePath>/static/supabase.js) and talks only to SUPABASE_URL.
 */
let supabaseBundle: Buffer | null = null;
export function supabaseBrowserBundle(): Buffer {
  if (!supabaseBundle) {
    const require = createRequire(import.meta.url);
    supabaseBundle = readFileSync(require.resolve('@supabase/supabase-js/dist/umd/supabase.js'));
  }
  return supabaseBundle;
}

export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
function browserJson(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c'); }

const STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 16px;color:#111;background:#fff}'
  + 'button{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0;cursor:pointer}input{font:inherit;padding:.4rem;width:100%;box-sizing:border-box;margin:.25rem 0}'
  + '.muted{color:#555}[hidden]{display:none!important}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.muted{color:#aaa}}';

export function sendPage(res: ServerResponse, status: number, title: string, body: string, options: { script?: string; connectOrigin?: string; basePath?: string } = {}): void {
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    `connect-src ${options.connectOrigin ?? "'none'"}`,
    "img-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': csp,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  const scripts = options.script
    ? `<script nonce="${nonce}" src="${htmlEscape(`${options.basePath ?? ''}/static/supabase.js`)}"></script><script nonce="${nonce}">${options.script}</script>`
    : '';
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>${body}</main>${scripts}</body></html>`);
}

export function sendMessagePage(res: ServerResponse, status: number, heading: string, message: string): void {
  sendPage(res, status, 'Desktop Commander relay', `<h1>${htmlEscape(heading)}</h1><p>${htmlEscape(message)}</p>`);
}

/**
 * Supabase OAuth 2.1 consent for ANY registered client (the device pairing
 * client, Claude, …). Supabase redirects here with ?authorization_id=…, and
 * everything shown comes from getAuthorizationDetails: nothing assumes which
 * client is asking. If the browser has no Supabase session, the same page
 * offers email sign-in. The standard Supabase template sends a magic link;
 * separately issued email OTPs remain supported as a fallback.
 */
export function sendConsentPage(res: ServerResponse, supabaseUrl: string, publishableKey: string, basePath = ''): void {
  const origin = new URL(supabaseUrl).origin;
  const wsOrigin = origin.replace(/^http/, 'ws');
  const body = `<h1>Authorize access</h1>
<p id="status" class="muted">Loading…</p>
<section id="signin" hidden>
  <p>Sign in to continue.</p>
  <form id="email-form"><input id="email" type="email" autocomplete="email" placeholder="you@example.com" required><button type="submit">Email me a sign-in link</button></form>
  <form id="otp-form"><p class="muted">Have a code? Enter an 8-digit code only if one was issued separately. The standard Supabase sign-in email contains a link, not a code.</p><input id="otp" inputmode="numeric" autocomplete="one-time-code" placeholder="12345678"><button type="submit">Verify code</button></form>
</section>
<section id="consent" hidden>
  <p><strong id="client-name"></strong> <span id="client-host" class="muted"></span> wants to access your account <strong id="user-email"></strong>.</p>
  <p class="muted">Client ID: <code id="client-id"></code></p>
  <p>Requested permissions:</p>
  <ul id="scopes"></ul>
  <button id="approve">Approve</button><button id="deny">Deny</button>
  <p class="muted"><button id="switch">Use a different account</button></p>
</section>`;
  const script = `(function(){
const SUPABASE_URL=${browserJson(supabaseUrl)}, KEY=${browserJson(publishableKey)};
const $=(id)=>document.getElementById(id);
const status=(t)=>{$('status').textContent=t;};
const params=new URLSearchParams(location.search);
const authorizationId=params.get('authorization_id');
const hadAuthCallback=params.has('code')||Boolean(location.hash);
const hashParams=new URLSearchParams(String(location.hash||'').replace(/^#/,''));
const callbackError=hashParams.get('error_description')||hashParams.get('error');
// New email sign-ins use implicit so a different browser context can complete.
// Keep PKCE only when an in-flight ?code= callback is already on the URL.
const flowType=params.has('code')?'pkce':'implicit';
const client=window.supabase.createClient(SUPABASE_URL,KEY,{auth:{flowType:flowType,persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const RESTART='Start again from the application that sent you here.';
let email='';
function returnUrl(){const u=new URL(location.href);u.searchParams.delete('code');u.hash='';return u.toString();}
function host(uri){try{return uri?'('+new URL(uri).host+')':'';}catch(e){return '';}}
async function showSignIn(){$('consent').hidden=true;$('signin').hidden=false;status('');}
async function showConsent(){
  if(!authorizationId){status('Missing authorization_id. '+RESTART);return;}
  const {data,error}=await client.auth.oauth.getAuthorizationDetails(authorizationId);
  if(error||!data){status(String((error&&error.message)||'This authorization request is no longer valid').replace(/[.!?]*$/,'.')+' '+RESTART);return;}
  if(data.redirect_url){status('Already approved. Returning…');location.assign(data.redirect_url);return;}
  const requester=data.client||{};
  $('client-name').textContent=requester.name||'An unnamed application';
  $('client-host').textContent=host(requester.uri);
  $('client-id').textContent=requester.id||'unknown';
  $('user-email').textContent=(data.user&&data.user.email)||'';
  const list=$('scopes');list.textContent='';
  const scopes=String(data.scope||'').split(/\\s+/).filter(Boolean);
  for(const scope of (scopes.length?scopes:['(default)'])){const li=document.createElement('li');li.textContent=scope;list.appendChild(li);}
  $('signin').hidden=true;$('consent').hidden=false;status('');
}
async function decide(approve){
  $('approve').disabled=true;$('deny').disabled=true;status(approve?'Approving…':'Denying…');
  const fn=approve?client.auth.oauth.approveAuthorization:client.auth.oauth.denyAuthorization;
  const {data,error}=await fn.call(client.auth.oauth,authorizationId,{skipBrowserRedirect:true});
  if(error||!data||!data.redirect_url){status((error&&error.message)||'Could not record your decision.');$('approve').disabled=false;$('deny').disabled=false;return;}
  location.assign(data.redirect_url);
}
$('email-form').addEventListener('submit',async(e)=>{e.preventDefault();email=$('email').value.trim();status('Sending…');
  const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:returnUrl(),shouldCreateUser:false}});
  if(error){status(error.message);return;}
  status('Check your email.');});
$('otp-form').addEventListener('submit',async(e)=>{e.preventDefault();
  // Works without sending an email (e.g. when email sending is rate-limited): the code is verified client-side with Supabase.
  email=$('email').value.trim();const token=$('otp').value.trim();
  if(!email||!token){status('Enter your email above and the code.');return;}
  status('Verifying…');
  const {error}=await client.auth.verifyOtp({email,token,type:'email'});
  if(error){status(error.message);return;} await showConsent();});
$('approve').addEventListener('click',()=>decide(true));
$('deny').addEventListener('click',()=>decide(false));
$('switch').addEventListener('click',async()=>{await client.auth.signOut();await showSignIn();});
window.__consentReady=(async()=>{
  // Snapshot callback presence before auth-js clears the fragment. Prefer
  // initialize() errors over getSession(), which only reports stored session.
  let initError=null;
  if(client.auth.initialize){const init=await client.auth.initialize();initError=init&&init.error;}
  const {data,error}=await client.auth.getSession();
  if(hadAuthCallback) history.replaceState(null,'',returnUrl());
  const visible=initError||error||(callbackError&&{message:callbackError});
  if(visible){await showSignIn();status(visible.message);return;}
  if(data.session) await showConsent(); else await showSignIn();
})().catch((e)=>status(e&&e.message||'Unexpected error'));
})();`;
  sendPage(res, 200, 'Authorize access', body, { script, connectOrigin: `${origin} ${wsOrigin}`, basePath });
}
