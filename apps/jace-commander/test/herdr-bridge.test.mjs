import assert from 'node:assert/strict';
import { buildHerdrArgv, parseHerdrOutput, isInHerdr, parseRequest } from '../scripts/herdr-bridge.mjs';

assert.deepEqual(buildHerdrArgv({operation:'status'}), ['status','--json']);
assert.deepEqual(buildHerdrArgv({operation:'sessions'}), ['session','list']);
assert.deepEqual(buildHerdrArgv({operation:'snapshot'}), ['api','snapshot']);
assert.deepEqual(buildHerdrArgv({operation:'agents'}), ['agent','list']);
assert.deepEqual(buildHerdrArgv({operation:'panes'}), ['pane','list']);
assert.deepEqual(buildHerdrArgv({operation:'workspaces'}), ['workspace','list']);
assert.deepEqual(buildHerdrArgv({operation:'pane_read',id:'w7:p1',lines:60}), ['pane','read','w7:p1','--source','recent-unwrapped','--lines','60']);
assert.deepEqual(buildHerdrArgv({operation:'agent_read',id:'reviewer',lines:15}), ['agent','read','reviewer','--source','recent-unwrapped','--lines','15']);
assert.deepEqual(parseHerdrOutput('{"ok":true}\n'), {format:'json',data:{ok:true}});
assert.deepEqual(parseHerdrOutput('name status\ndefault running\n'), {format:'text',data:'name status\ndefault running'});
assert.equal(isInHerdr({HERDR_ENV:'1',HERDR_WORKSPACE_ID:'w7',HERDR_PANE_ID:'w7:p1'}), true);
assert.equal(isInHerdr({HERDR_ENV:'1'}), false);
assert.equal(isInHerdr({HERDR_ENV:'0',HERDR_WORKSPACE_ID:'w7',HERDR_PANE_ID:'w7:p1'}), false);
for (const action of ['agent_prompt','pane_run','pane_send_keys','workspace_close','server_stop','shell']) {
  assert.throws(()=>buildHerdrArgv({operation:action,id:'w7:p1',text:'whoami'}),/unsupported|denied|read-only/i,`${action} must fail closed`);
}
for(const id of ['w7:p1;touch /tmp/hijack','../p1','--help','a b','']) {
  assert.throws(()=>buildHerdrArgv({operation:'pane_read',id}),/invalid/i);
}
for(const lines of [0,-1,501,'30',1.5]) {
  assert.throws(()=>buildHerdrArgv({operation:'pane_read',id:'w7:p1',lines}),/invalid/i);
}
assert.throws(()=>buildHerdrArgv({operation:'pane_read',id:'w7:p1',source:'ansi'}),/unsupported|invalid/i);
assert.throws(()=>parseRequest('{"operation":"agents","extra":true}'),/unsupported|invalid/i);
assert.throws(()=>parseRequest('{"operation":"agent_prompt","id":"x"}'),/unsupported|denied|read-only/i);
console.log('Herdr bridge contract: read-only commands, JSON, identity and injection defenses PASS');
