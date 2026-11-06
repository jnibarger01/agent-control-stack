import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createJcServer} from '../dist/server.js';
import {loadJcConfig} from '../dist/config.js';
import {makeIssuer,authorityBody} from './fixtures/jc-mint.js';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'jc-managed-'));
const root=path.join(tmp,'work'); fs.mkdirSync(root);
const issuer=makeIssuer(); let mode='active'; let helperCalls=0;
const config=loadJcConfig({JC_ACS_AUTHORITY_TOKEN:'test-authority-read-token',HOME:tmp,JC_STATE_DIR:path.join(tmp,'state'),JC_FS_ROOTS:root,
 JC_ACS_URL:'http://127.0.0.1:9',JC_RUNTIME_ID:'jc-test-runtime',JC_ACS_PUBLIC_KEY:issuer.publicKeyB64,
 JC_ACS_KEY_ID:issuer.keyId,JC_GATEWAY_META_TRUSTED:'1'});
const server=createJcServer(config,'managed',{
 helperAvailable:async()=>false,invokeHelper:async()=>{helperCalls++;return {ok:true};},
 fetchImpl:async()=>{
  if(mode==='outage') throw new Error('offline');
  const body=authorityBody(issuer);
  if(mode==='revoked') body.attemptLeases[0].status='revoked';
  if(mode==='expired') body.attemptLeases[0].expiresAt=new Date(0).toISOString();
  if(mode==='epoch') body.attemptLeases[0].fencingEpoch++;
  if(mode==='principal') body.workItem.requesterSubject='chatgpt:bob';
  if(mode==='plan') body.attemptLeases[0].planHash='f'.repeat(64);
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 }});
const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);
const client=new Client({name:'native-test',version:'1'});await client.connect(b);
function request(name,args,who='alice',overrides={}) {
 return {name,arguments:args,_meta:{gateway:{sub:who,client_id:'client'},acsCapability:issuer.mint(name,args,overrides)}};
}
const call=(...args)=>client.callTool(request(...args));
const code=(r)=>r.structuredContent?.error?.code;
const ok=(r)=>assert.equal(r.isError,undefined,JSON.stringify(r));
try {
 const file=path.join(root,'marker');
 const args={command:'printf approved',cwd:root,waitMs:1000};
 ok(await call('run_command',args));
 for (const state of ['revoked','expired','epoch','principal','plan','outage']) {
  mode=state;
  const r=await call('run_command',{command:'touch marker',cwd:root,waitMs:100});
  assert.equal(r.isError,true,state);assert.equal(fs.existsSync(file),false,state);
 }
 mode='active';
 const replay=request('run_command',args);ok(await client.callTool(replay));
 assert.equal(code(await client.callTool(replay)),'JC_CAPABILITY_NONCE_REPLAY');
 assert.equal(code(await call('run_command',args,'alice',{approvalId:undefined})),'JC_CAPABILITY_APPROVAL_REQUIRED');
 const bad=request('run_command',args);bad.arguments={...bad.arguments,command:'touch marker'};
 assert.equal(code(await client.callTool(bad)),'JC_CAPABILITY_ARGUMENTS_MISMATCH');
 assert.equal(fs.existsSync(file),false);
 const started=await call('start_terminal_session',{cwd:root,timeoutMs:3000});ok(started);
 const id=started.structuredContent.sessionId;
 const sent=await call('interact_with_process',{sessionId:id,input:'printf NATIVE_PTY\n',waitMs:100});ok(sent);
 assert.match(sent.structuredContent.stdout,/NATIVE_PTY/);
 assert.equal(code(await call('read_process_output',{sessionId:id},'bob')),'not_found');
 assert.equal(code(await call('kill_process',{sessionId:id},'bob')),'JC_AUTHORITY_REVOKED');
 ok(await call('kill_process',{sessionId:id}));
 const binary=path.join(root,'bytes.bin');
 ok(await call('write_file',{path:binary,encoding:'base64',content:Buffer.from([0,255,7]).toString('base64')}));
 assert.deepEqual([...fs.readFileSync(binary)],[0,255,7]);
 fs.symlinkSync('/etc',path.join(root,'link'));
 ok(await call('delete_file',{path:path.join(root,'link')}));
 assert.equal(fs.existsSync('/etc'),true);
 assert.equal(code(await call('delete_file',{path:root,recursive:true})),'path_denied');
 fs.mkdirSync(path.join(root,'nested','.git'),{recursive:true});
 fs.writeFileSync(path.join(root,'nested','keep'),'keep');
 assert.equal(code(await call('delete_file',{path:path.join(root,'nested'),recursive:true})),'path_denied');
 assert.equal(fs.existsSync(path.join(root,'nested','keep')),true);
 ok(await call('delete_file',{path:binary}));assert.equal(fs.existsSync(binary),false);
 mode='outage';
 // An ACS outage is ACS_UNAVAILABLE and never reaches the root helper.
 assert.equal(code(await call('privileged_exec',{argv:['/usr/bin/id']})),'ACS_UNAVAILABLE');
 assert.equal(helperCalls,0);
 console.log('native managed MCP: approval, revoke, expiry, epoch, principal, outage, replay, arguments, PTY, binary, delete PASS');
} finally {await client.close();fs.rmSync(tmp,{recursive:true,force:true});}
