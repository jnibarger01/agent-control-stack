/**
 * Minimal stdlib-only HTTP server exposing the audit chain as a live UI.
 *
 * GET /            — single-page dark-theme dashboard, auto-refresh 2s
 * GET /api/events  — JSON events (?limit=N&after=seq)
 * GET /api/verify  — chain verification result
 *
 * Binds 127.0.0.1 only; port via DC_AUDIT_UI_PORT (default 3777).
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuditChain, verifyChain, AUDIT_DIR, type StoredEvent } from './audit-chain.js';

const PORT = Number(process.env.DC_AUDIT_UI_PORT ?? 3777);
const HOST = '127.0.0.1';

function listAuditFiles(): string[] {
  try {
    return fs
      .readdirSync(AUDIT_DIR)
      .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(AUDIT_DIR, f));
  } catch {
    return [];
  }
}

function readAllEvents(): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const file of listAuditFiles()) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as StoredEvent);
      } catch {
        // skip
      }
    }
  }
  return events;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusOf(e: StoredEvent): string {
  if (e.error) return `<span class="fail">error</span>`;
  if (e.kind === 'result') return e.exitCode === 0 || e.exitCode == null ? '<span class="ok">ok</span>' : `<span class="fail">exit ${e.exitCode}</span>`;
  return '<span class="muted">—</span>';
}

function approvalOf(e: StoredEvent): string {
  if (e.kind === 'approval') return `<span class="ok">approval</span>`;
  if (e.approvalId) return `#${esc(e.approvalId)}`;
  return '<span class="muted">none</span>';
}

/** Breadcrumb: ChatGPT → OAuth gateway → MCP → executor → result. */
function breadcrumb(e: StoredEvent): string {
  const steps: string[] = [];
  steps.push(esc(e.sourceAgent ?? e.agent ?? 'chatgpt'));
  steps.push(esc(e.transport ?? 'mcp'));
  steps.push('MCP');
  steps.push(`executor${e.executorPid != null ? `:${e.executorPid}` : ''}`);
  steps.push(e.kind === 'result' ? 'result' : esc(e.kind));
  return steps.join(' → ');
}

function rowHtml(e: StoredEvent): string {
  const detail = esc(JSON.stringify(e, null, 2));
  return `<tr class="row" data-seq="${e.seq}">
<td>${esc(new Date(e.ts).toLocaleTimeString())}</td>
<td>${esc(e.sourceAgent ?? e.agent ?? '—')}</td>
<td>${esc(e.tool ?? e.kind)}</td>
<td>${e.durationMs != null ? `${e.durationMs}ms` : '—'}</td>
<td>${statusOf(e)}</td>
<td>${approvalOf(e)}</td>
<td>${e.error ? `<span class="fail">${esc(e.error)}</span>` : '—'}</td>
<td class="mono">${esc(String(e.resultHash ?? '').slice(0, 12))}</td>
</tr>
<tr class="detail hidden" data-detail-for="${e.seq}"><td colspan="8"><pre>${detail}</pre>
<div class="crumb">${breadcrumb(e)}</div></td></tr>`;
}

function renderPage(): string {
  const events = readAllEvents().slice(-200);
  const rows = events.map(rowHtml).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Desktop Commander — Audit</title>
<style>
body{background:#11151c;color:#d7dde6;font-family:ui-monospace,Menlo,monospace;margin:0;padding:16px}
h1{font-size:15px;color:#8ab4f8;margin:0 0 4px}
.sub{color:#5f6b7a;font-size:11px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#5f6b7a;border-bottom:1px solid #2a3342;padding:4px 6px;font-weight:normal}
td{padding:4px 6px;border-bottom:1px solid #1b2230}
tr.row:hover{background:#161d29;cursor:pointer}
tr.detail pre{background:#0d1117;border:1px solid #2a3342;padding:8px;font-size:11px;white-space:pre-wrap;max-height:280px;overflow:auto}
.hidden{display:none}
.ok{color:#5bd699}.fail{color:#f0716b}.muted{color:#5f6b7a}.mono{color:#8ab4f8}
.crumb{color:#c9a26b;font-size:11px;margin-top:6px}
#banner{padding:6px 10px;border-radius:4px;font-size:12px;margin-bottom:10px}
.banner-ok{background:#12261c;color:#5bd699}
.banner-fail{background:#2a1614;color:#f0716b}
</style></head><body>
<h1>Desktop Commander — Live Audit</h1>
<div class="sub">refresh 2s · <a id="verifyLink" href="/api/verify" style="color:#8ab4f8">/api/verify</a></div>
<div id="banner">…</div>
<table><thead><tr><th>time</th><th>agent</th><th>tool</th><th>duration</th><th>status</th><th>approval</th><th>error</th><th>resultHash</th></tr></thead>
<tbody id="rows">${rows}</tbody></table>
<script>
async function tick(){
  try{
    const after = Math.max(0, ...[...document.querySelectorAll('tr.row')].map(r=>+r.dataset.seq));
    const [ev, vf] = await Promise.all([
      fetch('/api/events?limit=200&after='+after).then(r=>r.json()),
      fetch('/api/verify').then(r=>r.json()),
    ]);
    const tb = document.getElementById('rows');
    for (const e of ev.events){
      tb.insertAdjacentHTML('beforeend', ${JSON.stringify('__ROW_TEMPLATE__') ? 'window.__row(e)' : ''});
    }
    if (ev.events.length === 0 && tb.children.length === 0){
      tb.innerHTML = '<tr><td colspan="8" class="muted">no events yet</td></tr>';
    }
    const b = document.getElementById('banner');
    if (vf.valid){ b.className='banner-ok'; b.textContent='chain valid · '+vf.events+' events'; }
    else { b.className='banner-fail'; b.textContent='CHAIN BROKEN at seq index '+vf.brokenAt+' — '+vf.error; }
  }catch(err){ console.error(err); }
}
window.__row = function(e){
  const tr=document.createElement('tr');tr.className='row';tr.dataset.seq=e.seq;
  const status = e.error?'<span class="fail">error</span>':(e.kind==='result'?((e.exitCode??0)===0?'<span class="ok">ok</span>':'<span class="fail">exit '+e.exitCode+'</span>'):'<span class="muted">—</span>');
  const appr = e.kind==='approval'?'<span class="ok">approval</span>':(e.approvalId?'#'+e.approvalId:'<span class="muted">none</span>');
  tr.innerHTML='<td>'+new Date(e.ts).toLocaleTimeString()+'</td><td>'+(e.sourceAgent??e.agent??'—')+'</td><td>'+(e.tool??e.kind)+'</td><td>'+(e.durationMs!=null?e.durationMs+'ms':'—')+'</td><td>'+status+'</td><td>'+appr+'</td><td>'+(e.error?'<span class="fail">'+e.error+'</span>':'—')+'</td><td class="mono">'+String(e.resultHash??'').slice(0,12)+'</td>';
  const det=document.createElement('tr');det.className='detail hidden';
  const steps=[e.sourceAgent??e.agent??'chatgpt', e.transport??'mcp','MCP','executor'+(e.executorPid!=null?':'+e.executorPid:''), e.kind==='result'?'result':e.kind].join(' → ');
  det.innerHTML='<td colspan="8"><pre>'+JSON.stringify(e,null,2).replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</pre><div class="crumb">'+steps+'</div></td>';
  tr.onclick=()=>det.classList.toggle('hidden');
  tr.after(det); return det;
};
document.getElementById('rows').addEventListener('click',ev=>{});
setInterval(tick,2000); tick();
</script></body></html>`;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

export function startAuditServer(options: { port?: number } = {}): Promise<http.Server> {
  const chain = new AuditChain();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = renderPage();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (url.pathname === '/api/events') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000);
        const after = Number(url.searchParams.get('after') ?? 0);
        let events = chain.read().events;
        if (after > 0) events = events.filter((e) => e.seq > after);
        json(res, 200, { events: events.slice(-limit) });
      } else if (url.pathname === '/api/verify') {
        const results = listAuditFiles().map((f) => ({ file: path.basename(f), ...verifyChain(f) }));
        const invalid = results.find((r) => !r.valid);
        json(res, 200, invalid ?? { valid: true, events: results.reduce((a, r) => a + r.events, 0), brokenAt: null, error: null, files: results.length });
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? PORT, HOST, () => resolve(server));
  });
}

export function startAuditServerDetached(options: { port?: number } = {}): http.Server {
  const serverRef = { current: null as http.Server | null };
  startAuditServer(options)
    .then((s) => {
      serverRef.current = s;
    })
    .catch(() => {
      // Port busy or bind failure: the UI is best-effort, never fatal.
    });
  return { close: () => serverRef.current?.close() } as unknown as http.Server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startAuditServer().then((s) => {
    const addr = s.address();
    console.log(`audit UI listening on http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : PORT}`);
  });
}
