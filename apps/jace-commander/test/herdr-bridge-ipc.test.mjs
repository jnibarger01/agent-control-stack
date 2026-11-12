import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/herdr-bridge.mjs', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-herdr-bridge-'));
const home = path.join(root, 'home');
const bin = path.join(root, 'bin');
fs.mkdirSync(bin, {recursive:true});
fs.mkdirSync(home);
const fake = path.join(bin, 'herdr');
fs.writeFileSync(fake, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a.join(' ')==='agent list')console.log(JSON.stringify({agents:[{name:'fable'}]}));\nelse if(a.join(' ')==='status --json')console.log(JSON.stringify({server:{running:true}}));\nelse if(a[0]==='pane'&&a[1]==='read')console.log('Output for '+a[2]);\nelse{process.stderr.write('unsupported fake command');process.exit(1)}\n`);
fs.chmodSync(fake,0o755);
const env = {...process.env,HOME:home,PATH:`${bin}:${process.env.PATH}`};
const heredrEnv = {...env,HERDR_ENV:'1',HERDR_WORKSPACE_ID:'w7',HERDR_TAB_ID:'w7:t1',HERDR_PANE_ID:'w7:p1'};
const socket = path.join(home,'projects','.jc-herdr-bridge','herdr.sock');
let server;
const heldClients = [];
const run = (mode,...args)=>{
  return execFileSync(process.execPath,[script,mode,...args],{env,encoding:'utf8',timeout:5000}).trim();
};
try {
  const direct = JSON.parse(run('direct','status'));
  assert.deepEqual(direct.result.data,{server:{running:true}});
  assert.throws(()=>run('direct','agents'),/only status and session inventory/);
  assert.throws(()=>run('request','agent_prompt','fable'),/read-only bridge/);
  server=spawn(process.execPath,[script,'serve'],{env:heredrEnv,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('bridge did not start')),5000);
    server.stdout.on('data',(chunk)=>{if(chunk.toString().includes('bridge ready')){clearTimeout(timer);resolve();}});
    server.on('error',(err)=>{clearTimeout(timer);reject(err)});
    server.on('exit',code=>{clearTimeout(timer);reject(new Error(`bridge exited ${code}`))});
  });
  assert.equal(fs.statSync(socket).mode&0o777,0o600);
  assert.equal(fs.statSync(path.dirname(socket)).mode&0o777,0o700);
  const agents=JSON.parse(run('request','agents'));
  assert.equal(agents.ok,true);
  assert.deepEqual(agents.result.data,{agents:[{name:'fable'}]});
  assert.deepEqual(agents.context,{workspace:'w7',pane:'w7:p1'});
  const pane=JSON.parse(run('request','pane_read','w7:p42','30'));
  assert.equal(pane.result.data,'Output for w7:p42');
  assert.equal(pane.result.format,'text');
  assert.throws(()=>run('request','pane_read','--help'),/invalid pane\/agent id/);
  assert.throws(()=>run('request','pane_run','w7:p42'),/read-only bridge/);
  // Exhaust the eight-connection limit, including rejected attempts.
  for (let i=0;i<8;i++) {
    const c = net.createConnection(socket);
    await new Promise((resolve,reject)=>{c.once('connect',resolve);c.once('error',reject)});
    heldClients.push(c);
  }
  const shouldReject = async () => {
    const c = net.createConnection(socket);
    try {
      const outcome = await Promise.race([new Promise(resolve=>c.once('close',()=>resolve('closed'))),new Promise(resolve=>setTimeout(()=>resolve('accepted'),450))]);
      assert.equal(outcome,'closed','more than eight concurrent requests must be rejected');
    } finally { c.destroy(); }
  };
  await shouldReject();
  await new Promise(r=>setTimeout(r,100));
  await shouldReject(); // a rejected client must not consume/decrement an existing slot
  console.log('Herdr IPC: structured JSON, bounded read, private socket, denied writes PASS');
} finally {
  for (const c of heldClients) c.destroy();
  if(server){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}
  fs.rmSync(root,{recursive:true,force:true});
}
