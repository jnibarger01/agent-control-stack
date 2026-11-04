import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JC_MANIFEST} from '../dist/manifest.generated.js';
const baseline=JSON.parse(fs.readFileSync(new URL('./fixtures/jc-tools-baseline-v1.json',import.meta.url),'utf8'));
assert.equal(baseline.tools.length,36);
for (const old of baseline.tools) {
 const current=JC_MANIFEST.tools.find((tool)=>tool.name===old.name);assert.ok(current,old.name);
 assert.deepEqual(current.inputSchema.required,old.inputSchema.required,old.name+' required');
 for (const [name,schema] of Object.entries(old.inputSchema.properties??{})) {
  // Descriptions may improve without changing the accepted values.
  const strip=(x)=>Array.isArray(x)?x.map(strip):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='description').map(([k,v])=>[k,strip(v)])):x;
  assert.deepEqual(strip(current.inputSchema.properties[name]),strip(schema),old.name+'.'+name);
 }
}
console.log('PASS: all 36 legacy tool schemas preserved; additions are optional or new tools');
