#!/usr/bin/env node
/**
 * Workload isolation regression suite (sandbox.ts). Real bubblewrap, real
 * processes, no mocks: every workload JC launches must be unable to reach the
 * control plane's credentials even though it runs as the same UID.
 *
 * Fixtures live under $HOME/.cache (a real, host-visible directory), NOT /tmp:
 * the sandbox has a private /tmp, so /tmp fixtures would pass vacuously.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessRegistry } from '../dist/processes.js';
import { gitAdd } from '../dist/git-ops.js';
import { sandboxPolicyFromEnv, sandboxSelfTest, sandboxArgv } from '../dist/sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CANARY = `jc-canary-${process.pid}-${Date.now()}`;
const base = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'jc-isolation-'));
const home = path.join(base, 'home');
const work = path.join(home, 'work');
const stateDir = path.join(home, '.jace-commander');
const runtimeDir = path.join(base, 'run-user');
for (const dir of [work, stateDir, runtimeDir, path.join(home, '.ssh'), path.join(home, '.config', 'jace-commander'), path.join(home, '.config', 'systemd', 'user')]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(home, '.config', 'jace-commander', 'jc.env'), `DC_GATEWAY_EXECUTION_TOKEN=${CANARY}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, 'device-login.json'), JSON.stringify({ token: CANARY }), { mode: 0o600 });
fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), CANARY, { mode: 0o600 });
fs.writeFileSync(path.join(runtimeDir, 'bus'), CANARY);
fs.writeFileSync(path.join(home, '.bashrc'), '# original\n');

// The control plane's own environment carries the canary (as the bridge/JC env does).
process.env.DC_GATEWAY_EXECUTION_TOKEN = CANARY;
// A sibling "bridge" process with the canary in its environ, like bridge.js.
const sibling = spawn('/bin/sleep', ['60'], { env: { PATH: '/usr/bin:/bin', ACS_WORKER_TOKEN: CANARY }, stdio: 'ignore' });

function workloadPolicy(extraEnv = {}) {
  const policy = sandboxPolicyFromEnv({ homeDir: home, stateDir, fsRoots: [work], fsDeniedRoots: [], managed: true },
    { XDG_RUNTIME_DIR: runtimeDir, ...extraEnv });
  return { roots: [work], deniedRoots: [], workload: { policy, homeDir: home, stateDir } };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const policy = workloadPolicy();
const registry = createProcessRegistry();
const run = async (command, extra = {}) => registry.run({ command, cwd: work, waitMs: 10_000, ...extra }, policy, 'alice');

try {
  await test('self-test proves pid/mount isolation before anything runs', () => {
    const result = sandboxSelfTest(policy.workload.policy, home, stateDir);
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.isolation, 'bwrap');
  });

  await test('host processes are invisible: no JC / bridge environ, no signals', async () => {
    const out = await run(`cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c ${CANARY}; ls /proc | grep -c '^[0-9]'; kill -0 ${process.pid} 2>&1; kill -0 ${sibling.pid} 2>&1; cat /proc/${sibling.pid}/environ 2>&1`);
    assert.equal(out.exitCode, 1, out.stderr);
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(`${CANARY}`));
    const [count, procs] = out.stdout.trim().split('\n');
    assert.equal(count, '0');
    assert.ok(Number(procs) <= 6, `only sandbox pids visible, saw ${procs}`);
    assert.match(out.stdout + out.stderr, /No such process|No such file/);
  });

  await test('credential stores, JC env/state and the runtime bus are masked', async () => {
    const out = await run([
      `cat ${home}/.config/jace-commander/jc.env`, `cat ${stateDir}/device-login.json`, `cat ${home}/.ssh/id_ed25519`,
      `cat ${runtimeDir}/bus`, `grep -rs ${CANARY} ${home} | head -1`, 'true',
    ].map((c) => `${c} 2>/dev/null`).join('; '));
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(CANARY));
  });

  await test('nothing outside the roots is writable: no dotfile / unit / runtime persistence', async () => {
    const out = await run([
      `echo evil >> ${home}/.bashrc`, `echo evil > ${home}/.config/systemd/user/evil.service`,
      `touch ${path.resolve(here, '..', 'dist', 'evil.js')}`, 'touch /usr/local/evil', `touch ${stateDir}/evil`,
    ].map((c) => `{ ${c}; } 2>/dev/null && echo WROTE:${c.split(' ').pop()}`).join('; ') + '; echo done');
    assert.doesNotMatch(out.stdout, /WROTE:/, out.stdout);
    assert.equal(fs.readFileSync(path.join(home, '.bashrc'), 'utf8'), '# original\n');
    assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'evil.service')), false);
    assert.equal(fs.existsSync(path.resolve(here, '..', 'dist', 'evil.js')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'evil')), false);
  });

  await test('the filesystem root stays writable and results are visible to the host', async () => {
    const out = await run('printf built > artifact.txt && cat artifact.txt');
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(fs.readFileSync(path.join(work, 'artifact.txt'), 'utf8'), 'built');
  });

  await test('capabilities are gone and nested user namespaces are refused (masks cannot be undone)', async () => {
    const out = await run('unshare -U true 2>&1 && echo NESTED; umount /tmp 2>&1 && echo UNMOUNTED; grep CapEff /proc/self/status');
    assert.doesNotMatch(out.stdout, /NESTED|UNMOUNTED/);
    assert.match(out.stdout, /CapEff:\s+0+\b/);
  });

  await test('interactive PTY works inside the sandbox (private devpts)', async () => {
    const session = await registry.terminal({ cwd: work, timeoutMs: 10_000 }, policy, 'alice');
    const out = await registry.interact({ sessionId: session.sessionId, input: 'test -t 0 && tty && echo PTY_$((40+2))\n', waitMs: 5000 }, 'alice');
    assert.match(out.stdout, /PTY_42/);
    assert.match(out.stdout, /\/dev\/pts\/\d+/);
    assert.equal((await registry.kill({ sessionId: session.sessionId }, 'alice')).exited, true);
  });

  await test('network none (default) cannot reach host loopback services; host mode is explicit opt-in', async () => {
    const server = net.createServer((socket) => socket.end('LOOPBACK_REACHED')).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const probe = `exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3`;
    const blocked = await run(probe, { shell: '/bin/bash' });
    assert.doesNotMatch(blocked.stdout, /LOOPBACK_REACHED/);
    const hostPolicy = workloadPolicy({ JC_WORKLOAD_NETWORK: 'host' });
    const reached = await registry.run({ command: probe, cwd: work, waitMs: 5000 }, hostPolicy, 'alice');
    assert.match(reached.stdout, /LOOPBACK_REACHED/);
    server.close();
  });

  await test('git runs sandboxed: a planted clean filter cannot read the control plane', async () => {
    const repo = path.join(work, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'jc@example.com');
    git('config', 'user.name', 'JC');
    // What a malicious approved workload could plant into .git/config:
    const leak = path.join(work, 'leak.txt');
    git('config', 'filter.evil.clean', `sh -c 'cat /proc/*/environ ${home}/.config/jace-commander/jc.env > ${leak} 2>/dev/null; cat'`);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'data\n');
    await gitAdd({ repo, paths: ['a.txt'] }, policy);
    assert.ok(fs.existsSync(leak), 'the filter ran (inside the sandbox)');
    assert.doesNotMatch(fs.readFileSync(leak, 'utf8'), new RegExp(CANARY));
  });

  await test('no workload survives kill or timeout, even when killed during sandbox startup', async () => {
    const survivors = (marker) => fs.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(marker);
      } catch {
        return false;
      }
    });
    for (let round = 0; round < 60; round += 1) {
      // A unique sleep duration marks this round's workload in the host process table.
      const marker = `${300 + round}.${process.pid % 1000}`;
      const started = registry.start({ argv: ['/bin/sleep', marker], cwd: work, timeoutMs: 60_000 }, policy, 'alice');
      // Sweep the kill across bubblewrap's startup (fork -> die-with-parent armed -> exec).
      await new Promise((resolve) => setTimeout(resolve, round % 15));
      const killed = await registry.kill({ sessionId: started.sessionId }, 'alice');
      assert.equal(killed.exited, true, JSON.stringify(killed));
      assert.deepEqual(survivors(marker), [], `round ${round}: sandboxed workload survived kill`);
    }
    const timedMarker = `299.${process.pid % 1000}`;
    const timed = await registry.run({ command: `exec /bin/sleep ${timedMarker}`, cwd: work, timeoutMs: 200, waitMs: 3000 }, policy, 'alice');
    assert.equal(timed.running, false);
    assert.deepEqual(survivors(timedMarker), [], 'workload survived its timeout');
  });

  await test('fail closed: no sandbox, a missing bwrap, or isolation=none in managed mode never runs anything', async () => {
    await assert.rejects(registry.run({ command: 'true', cwd: work }, { roots: [work], deniedRoots: [] }, 'alice'), /JC_SANDBOX_UNAVAILABLE|no workload sandbox/);
    const broken = workloadPolicy({ JC_BWRAP_PATH: '/nonexistent/bwrap' });
    await assert.rejects(registry.run({ command: `touch ${work}/ran`, cwd: work }, broken, 'alice'), /workload isolation is unavailable/);
    assert.equal(fs.existsSync(path.join(work, 'ran')), false);
    assert.throws(() => sandboxPolicyFromEnv({ homeDir: home, stateDir, fsRoots: [work], fsDeniedRoots: [], managed: true }, { JC_WORKLOAD_ISOLATION: 'none', JC_ALLOW_UNISOLATED_WORKLOADS: '1' }), /refused/);
    assert.throws(() => sandboxPolicyFromEnv({ homeDir: home, stateDir, fsRoots: [work], fsDeniedRoots: [], managed: false }, { JC_WORKLOAD_ISOLATION: 'none' }), /refused/);
  });

  await test('masks win inside writable roots (a hidden path under a root stays hidden)', () => {
    const argv = sandboxArgv(workloadPolicy({ JC_SANDBOX_HIDE: path.join(work, 'secretdir') }).workload.policy, ['/bin/true'], work);
    fs.mkdirSync(path.join(work, 'secretdir'), { recursive: true });
    const argv2 = sandboxArgv(workloadPolicy({ JC_SANDBOX_HIDE: path.join(work, 'secretdir') }).workload.policy, ['/bin/true'], work);
    const rw = argv2.indexOf(work);
    const hide = argv2.lastIndexOf(path.join(work, 'secretdir'));
    assert.ok(rw > 0 && hide > rw, 'the mask is applied after the writable root bind');
    void argv;
  });
} finally {
  registry.close();
  sibling.kill('SIGKILL');
  fs.rmSync(base, { recursive: true, force: true });
}
console.log(`\njace-commander workload isolation: ${passed} passed`);
