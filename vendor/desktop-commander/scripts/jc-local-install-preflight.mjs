#!/usr/bin/env node
/** Read-only host trust preflight for JC local execution.
 * Exits nonzero unless identities, trust anchors, socket, and storage are safe.
 * Never creates users, directories, keys or service units.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const checks = [];
const check = (name, condition, detail) => checks.push({ name, ok: Boolean(condition), detail });
function user(name) {
  try {
    const line = execFileSync('getent', ['passwd', name], { encoding:'utf8', timeout:2000 }).trim();
    const fields = line.split(':');
    return fields.length >= 7 ? { uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5], shell: fields[6] } : null;
  } catch { return null; }
}
function safeChain(file, ownerUid = 0, privateFile = false) {
  try {
    if (!path.isAbsolute(file)) return { ok:false, detail:'not absolute' };
    const parts = path.resolve(file).split(path.sep).filter(Boolean);
    let current = '/';
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) return { ok:false, detail:'symlink in path' };
      if (i < parts.length - 1) {
        if (!st.isDirectory() || st.uid !== 0 && st.uid !== ownerUid ||
          (st.mode & 0o002) !== 0) return { ok:false, detail:'untrusted directory component' };
      } else if (!st.isFile() || st.uid !== ownerUid ||
        (st.mode & (privateFile ? 0o077 : 0o022)) !== 0 ||
        st.size < 1 || st.size > 65536) return { ok:false, detail:'untrusted owner, mode or size' };
    }
    return { ok:true, detail:'owner, mode, path checked' };
  } catch (e) { return { ok:false, detail:e.code || 'unreadable' }; }
}
const jc = user('jc'), signer = user('jc-approverd'), operator = user(os.userInfo().username);
check('jc identity exists', jc && jc.uid !== 0, jc ? String(jc.uid) : 'missing');
check('approverd identity exists', signer && signer.uid !== 0, signer ? String(signer.uid) : 'missing');
check('service identities isolated', jc && signer && operator && jc.uid !== signer.uid &&
  jc.uid !== operator.uid && signer.uid !== operator.uid, 'jc, signer and operator must have distinct UIDs');
for (const [name,file,uid,isPrivate] of [
  ['local policy','/etc/jace-commander/local-policy.json',0,false],
  ['signer verification key','/etc/jace-commander/approverd-public.pem',0,false],
  ['operator verification key','/etc/jace-commander/operator-public.pem',0,false],
  ['signer private key','/var/lib/jc-approverd/signing-private.pem',signer?.uid ?? -1,true],
]) {
  const result = safeChain(file,uid,isPrivate);
  check(name,result.ok,result.detail);
}
try {
  const socket = '/run/jace-commander/approverd.sock';
  const st = fs.lstatSync(socket);
  check('approval socket',st.isSocket() && !st.isSymbolicLink() &&
    signer && st.uid === signer.uid && (st.mode & 0o007) === 0,
    st.isSocket() ? 'unix socket inspected' : 'not a socket');
  if (signer) {
    const groups = execFileSync('id',['-G','jc'],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
    check('jc has signer socket group',groups.includes(st.gid),'jc supplementary groups checked');
  }
} catch(e) {check('approval socket',false,e.code || 'unavailable');}
try {
  const st = fs.statSync('/var/lib/jc-approverd');
  check('signer state directory',st.isDirectory() && signer && st.uid === signer.uid &&
    (st.mode & 0o077) === 0,'must be private and signer-owned');
} catch(e) {check('signer state directory',false,e.code || 'unavailable');}
try {
  const st = fs.statSync('/etc/jace-commander');
  check('root-controlled config directory',st.uid === 0 && (st.mode & 0o022) === 0,
    'root-owned and not group/world writable');
} catch(e) {check('root-controlled config directory',false,e.code || 'unavailable');}
console.log(JSON.stringify({ok: checks.every(c=>c.ok), checks},null,2));
if (checks.some(c=>!c.ok)) process.exitCode=1;
