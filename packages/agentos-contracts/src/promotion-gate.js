/**
 * codex-swarm promotion gate contract.
 *
 * evaluateGate(evidence) is fail-closed:
 *   - any required key missing or not strictly boolean -> FAIL (gate_missing_evidence)
 *   - any required gate false                          -> FAIL
 *   - raw evidence contradicting a claimed boolean     -> FAIL (evidence beats assertion)
 *
 * Evidence-beats-assertion checks:
 *   - head_sha: if head_sha_expected/head_sha_actual present, they must match,
 *     regardless of head_sha_verified claim. Merge by SHA, never by branch name.
 *   - tests/typecheck/lint: if *_exit_code present, it must be 0 for the claim
 *     to stand. "tests passed" without exit_code 0 evidence is a lie with a tie on.
 */
export const REQUIRED_GATES = Object.freeze([
  'head_sha_verified',
  'worktree_clean',
  'tests_passed',
  'typecheck_passed',
  'lint_passed',
  'secret_scan_passed',
  'unexpected_diff',      // must be false
  'reviewer_approved',
  'approval_recorded',
  'trace_recorded',
]);

const REMEDIATION = Object.freeze({
  head_sha_verified: 'Re-resolve branch to SHA at merge time; compare against the SHA the Verifier tested. Abort on mismatch. Never merge by branch name.',
  worktree_clean: 'Run `git status --porcelain` in the worktree; stash/quarantine unrelated files; re-run verification on a clean tree.',
  tests_passed: 'Run the repo test command; attach exit code and summary to evidence. Fix failures before re-submitting.',
  typecheck_passed: 'Run typecheck (tsc --noEmit or repo equivalent); attach exit code. Fix errors.',
  lint_passed: 'Run lint; attach exit code. Fix or explicitly waive with reviewer sign-off (waiver is itself a trace event).',
  secret_scan_passed: 'Run secret scan on the diff (gitleaks/trufflehog or repo scanner). Remove secrets, rotate anything exposed, re-scan.',
  unexpected_diff: 'Diff against declared file scope. Quarantine out-of-scope changes into a separate task; re-run gate on scoped diff.',
  reviewer_approved: 'Route diff to Reviewer role (security, scope creep, regression risk). Maker cannot approve own work.',
  approval_recorded: 'Human approval missing for write+ risk. Submit to approval queue; record approval_decision in trace.',
  trace_recorded: 'No trace, no write. Open a LoopTrace run, record the full event chain, re-submit with trace_id.',
  gate_missing_evidence: 'Gate evidence object incomplete or mistyped. Every required gate must be an explicit boolean. Rebuild evidence from actual command output.',
});

/**
 * @param {object} evidence gate evidence object (see REQUIRED_GATES) plus optional raw evidence:
 *   head_sha_expected, head_sha_actual,
 *   tests_exit_code, typecheck_exit_code, lint_exit_code, trace_id
 * @returns {{ promoted: boolean, failures: string[], remediation: string[], failure_code: string|null }}
 */
export function evaluateGate(evidence) {
  const failures = [];

  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return fail(['gate_missing_evidence']);
  }

  // 1) Structural: every required gate must be strictly boolean.
  for (const key of REQUIRED_GATES) {
    if (typeof evidence[key] !== 'boolean') {
      return fail(['gate_missing_evidence'], [`missing/mistyped gate: ${key}`]);
    }
  }

  // 2) Evidence-beats-assertion overrides.
  const e = { ...evidence };
  if ('head_sha_expected' in e || 'head_sha_actual' in e) {
    const match =
      typeof e.head_sha_expected === 'string' &&
      typeof e.head_sha_actual === 'string' &&
      /^[0-9a-f]{7,40}$/.test(e.head_sha_expected) &&
      e.head_sha_expected === e.head_sha_actual;
    if (!match) e.head_sha_verified = false;
  }
  for (const [gate, code] of [
    ['tests_passed', 'tests_exit_code'],
    ['typecheck_passed', 'typecheck_exit_code'],
    ['lint_passed', 'lint_exit_code'],
  ]) {
    if (code in e && e[code] !== 0) e[gate] = false;
  }
  if ('trace_id' in e && !(typeof e.trace_id === 'string' && e.trace_id.length >= 6)) {
    e.trace_recorded = false;
  }

  // 3) Gate evaluation.
  for (const key of REQUIRED_GATES) {
    const wantFalse = key === 'unexpected_diff';
    const pass = wantFalse ? e[key] === false : e[key] === true;
    if (!pass) failures.push(key);
  }

  if (failures.length) return fail(failures);
  return { promoted: true, failures: [], remediation: [], failure_code: null };

  function fail(fails, extra = []) {
    const failure_code =
      fails.includes('gate_missing_evidence') ? 'gate_missing_evidence'
      : fails.includes('trace_recorded') ? 'trace_missing'
      : fails.includes('approval_recorded') ? 'approval_required'
      : fails.includes('secret_scan_passed') ? 'secret_detected'
      : fails.includes('unexpected_diff') ? 'unexpected_diff'
      : fails.includes('worktree_clean') ? 'dirty_worktree'
      : fails.includes('tests_passed') ? 'test_failed'
      : fails.includes('typecheck_passed') ? 'typecheck_failed'
      : fails.includes('lint_passed') ? 'lint_failed'
      : 'policy_blocked';
    return {
      promoted: false,
      failures: fails,
      remediation: [...extra, ...fails.map((f) => `${f}: ${REMEDIATION[f] ?? REMEDIATION.gate_missing_evidence}`)],
      failure_code,
    };
  }
}
