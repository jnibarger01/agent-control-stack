/**
 * Smoke: full gated coding loop, in-memory.
 * envelope -> validate -> route -> approval -> agent run -> gate (fail) ->
 * remediation -> gate (pass) -> promotion -> sealed, verified trace.
 * Exit 0 only if every stage behaves per contract.
 */
import {
  makeEnvelope, route, createTrace, verifyChain, evaluateGate,
} from '../src/index.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// 1. Envelope + routing
const envelope = makeEnvelope({
  task_id: 'task-smoke-000001',
  goal: 'Implement head_sha verification in codex-swarm promoter',
  origin: 'cli',
  task_type: 'coding',
  allowed_tools: ['read_file', 'apply_patch', 'run_command:test'],
  workspace: '/home/jacen/dev/codex-swarm',
  risk_level: 'write',
  approval_required: true,
  success_criteria: ['promoter merges by verified SHA', 'all gate tests pass'],
  trace_required: true,
});
const decision = route(envelope);
check('route ok', decision.ok === true);
check('routed to codex-swarm', decision.target === 'codex-swarm');
check('write task queued for approval', decision.queued_for_approval === true);

// 2. Trace the run
const sink = [];
const trace = createTrace('run-smoke-000001', { sink: (e) => sink.push(e) });
trace.append('task_received', { envelope });
trace.append('task_validated', { ok: true });
trace.append('risk_classified', { effective_risk: decision.effective_risk });
trace.append('route_selected', { target: decision.target });
trace.append('approval_requested', { risk: decision.effective_risk });
trace.append('approval_decision', { decision: 'approved', by: 'jace', channel: 'cli' });
trace.append('agent_started', { role: 'maker' });
trace.append('tool_call_started', { tool: 'apply_patch' });
trace.append('tool_call_finished', { tool: 'apply_patch', exit: 0 });
trace.append('verification_started', { suite: 'npm test' });
trace.append('verification_finished', { exit_code: 1, summary: '1 failing' });

// 3. Gate must block on failing tests even if Maker claims success
const dirtyEvidence = {
  head_sha_verified: true,
  worktree_clean: true,
  tests_passed: true,            // Maker's optimistic claim
  tests_exit_code: 1,            // reality
  typecheck_passed: true, typecheck_exit_code: 0,
  lint_passed: true, lint_exit_code: 0,
  secret_scan_passed: true,
  unexpected_diff: false,
  reviewer_approved: true,
  approval_recorded: true,
  trace_recorded: true, trace_id: 'run-smoke-000001',
  head_sha_expected: 'aaaabbbbccccddddeeeeffff0000111122223333',
  head_sha_actual: 'aaaabbbbccccddddeeeeffff0000111122223333',
};
const blocked = evaluateGate(dirtyEvidence);
check('gate blocks optimistic claim (evidence beats assertion)', blocked.promoted === false);
check('failure_code = test_failed', blocked.failure_code === 'test_failed');
trace.append('promotion_blocked', { failure_code: blocked.failure_code, failures: blocked.failures });

// 4. Remediate, re-verify, promote
trace.append('verification_started', { suite: 'npm test', attempt: 2 });
trace.append('verification_finished', { exit_code: 0, summary: 'all passing' });
const clean = { ...dirtyEvidence, tests_exit_code: 0 };
const promoted = evaluateGate(clean);
check('gate promotes on clean evidence', promoted.promoted === true);
trace.append('promotion_completed', { head_sha: clean.head_sha_actual });
trace.append('run_completed', { status: 'ok' });
trace.seal();

// 5. Chain integrity + persistence
const v = verifyChain(trace.events);
check('trace chain verifies', v.ok === true);
check('sink captured all events (JSONL-ready)', sink.length === trace.events.length);

console.log(failures === 0 ? '\nSMOKE: PASS' : `\nSMOKE: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
