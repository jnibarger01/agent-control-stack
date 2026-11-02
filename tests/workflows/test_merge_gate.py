"""Regression tests for the PR merge classifier and Dependabot auto-merge.

Static tests read the workflow files. Behavioural tests run the real `run:`
scripts under bash against a stub `gh` with fixtures. The stub records calls
and never reaches GitHub, so these tests check the workflow's own decisions,
not GitHub's enforcement (approvals, required checks, head matching). Those
platform behaviours are documented as unverified in the PR.

Run: python3 -m unittest tests/workflows/test_merge_gate.py   (needs PyYAML)
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / ".github/workflows/jnibarger01-pr-review-merge.yml"
DEPENDABOT = ROOT / ".github/workflows/dependabot-auto-merge.yml"
REPO = "jnibarger01/agent-control-stack"
HEAD = "a" * 40
OTHER = "b" * 40
GITHUB_TOKEN = "github-token-value-not-real"

GOOD_RULES = [
    {"type": "required_status_checks", "parameters": {"required_status_checks": [
        {"context": "check", "integration_id": 15368}, {"context": "test", "integration_id": 15368}]}},
    {"type": "pull_request", "parameters": {
        "require_last_push_approval": True, "dismiss_stale_reviews_on_push": True,
        "required_reviewers": [{"file_patterns": [".github/**"], "minimum_approvals": 1, "reviewer": {}}]}},
]
CURRENT_RULES = [  # what main actually has today
    {"type": "required_status_checks", "parameters": {"required_status_checks": [
        {"context": "check"}, {"context": "test"}]}},
]

STUB = r'''#!/usr/bin/env bash
label=github
[[ -n "${MERGE_TOKEN:-}" && "${GH_TOKEN:-}" == "$MERGE_TOKEN" ]] && label=merge
args="$*"
echo "$label | $args" >> "$STUB_LOG"
jq_filter=""; prev=""
for a in "$@"; do [[ "$prev" == "--jq" ]] && jq_filter="$a"; prev="$a"; done
emit() { if [[ -n "$jq_filter" ]]; then jq -r "$jq_filter"; else cat; fi; }
case "$args" in
  "pr merge"*|"pr comment"*) echo ok ;;
  *"/files"*) emit < "$STUB_FIX/files.json" ;;
  *"/rules/branches/"*) cat "$STUB_FIX/rules.json" ;;
  *"/pulls/"*) cat "$STUB_FIX/pr.json" ;;
  *) echo '{}' ;;
esac
'''


def pr(author="jnibarger01", draft=False, head=HEAD, base="main", state="open",
       head_repo=REPO, changed=1):
    return {"state": state, "draft": draft, "user": {"login": author}, "head": {"sha": head,
            "repo": {"full_name": head_repo}}, "base": {"ref": base}, "changed_files": changed}


def files(*rows):
    """rows: (filename, previous_filename or '', status)"""
    return [{"filename": n, "previous_filename": p or None, "status": s} for n, p, s in rows]


def load_run(path, step_name):
    jobs = yaml.safe_load(path.read_text(encoding="utf-8"))["jobs"]
    for job in jobs.values():
        for step in job["steps"]:
            if step.get("name") == step_name:
                return step["run"], step.get("env", {})
    raise KeyError(step_name)


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="merge-gate-test-"))
        self.fix = self.tmp / "fix"; self.fix.mkdir()
        self.bin = self.tmp / "bin"; self.bin.mkdir()
        (self.bin / "gh").write_text(STUB, encoding="utf-8")
        (self.bin / "gh").chmod(0o755)
        self.log = self.tmp / "calls.log"
        self.summary = self.tmp / "summary.md"
        self.log.write_text(""); self.summary.write_text("")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fixtures(self, pr_obj=None, files_list=None, rules=None):
        (self.fix / "pr.json").write_text(json.dumps(pr_obj or pr()))
        (self.fix / "files.json").write_text(json.dumps(files_list if files_list is not None else files(("packages/x/index.ts", "", "modified"))))
        (self.fix / "rules.json").write_text(json.dumps(rules if rules is not None else GOOD_RULES))

    def run_step(self, path, step_name, extra_env=None, attested=True):
        script, _ = load_run(path, step_name)
        env = dict(os.environ)
        env.update({
            "PATH": f"{self.bin}:{env['PATH']}", "STUB_LOG": str(self.log), "STUB_FIX": str(self.fix),
            "GH_TOKEN": GITHUB_TOKEN, "REPO": REPO, "PR": "7", "EXPECTED_HEAD": HEAD,
            "ATTESTED_ACTIONS_CANNOT_APPROVE": "true" if attested else "",
            "GITHUB_STEP_SUMMARY": str(self.summary),
        })
        env.update(extra_env or {})
        p = self.tmp / "step.sh"; p.write_text(script)
        return subprocess.run(["bash", str(p)], env=env, capture_output=True, text=True, timeout=120)

    def gate(self, **kw):
        return self.run_step(GATE, "Classify and enable auto-merge", **kw)

    def calls(self):
        return self.log.read_text().splitlines()

    def enabled(self):
        return any(" pr merge " in c and "--auto" in c and f"--match-head-commit {HEAD}" in c for c in self.calls())

    def disabled(self):
        return any("--disable-auto" in c for c in self.calls())

    def assert_no_merge_endpoint(self):
        self.assertFalse(any("-X PUT" in c or "/merge" in c and "pulls/" in c for c in self.calls()),
                         "classifier must never call the merge endpoint directly")

    def assert_blocked(self, res):
        self.assertNotEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertFalse(self.enabled(), "BLOCK must not enable auto-merge")
        self.assert_no_merge_endpoint()


class StaticTests(unittest.TestCase):
    def setUp(self):
        self.gate = yaml.safe_load(GATE.read_text())
        self.dep = yaml.safe_load(DEPENDABOT.read_text())
        self.texts = {p: p.read_text() for p in (GATE, DEPENDABOT)}

    def test_only_pull_request_target_and_no_dispatch(self):
        for d in (self.gate, self.dep):
            self.assertEqual(list(d[True].keys()), ["pull_request_target"])
        for t in self.texts.values():
            self.assertNotIn("workflow_dispatch", t)

    def test_no_checkout_of_any_code(self):
        for t in self.texts.values():
            self.assertNotIn("actions/checkout", t)
            self.assertNotIn("git fetch", t)
            self.assertNotIn("gh pr checkout", t)

    def test_no_app_key_or_merge_credential(self):
        for t in self.texts.values():
            self.assertNotIn("create-github-app-token", t)
            self.assertNotIn("ACS_MERGE_APP", t)
        self.assertNotIn("secrets.", self.texts[GATE])

    def test_no_direct_merge_endpoint_call(self):
        for t in self.texts.values():
            self.assertNotIn("-X PUT", t)
            self.assertNotIn("/merge\"", t)

    def test_least_privilege_permissions(self):
        for d in (self.gate, self.dep):
            self.assertEqual(d["permissions"], {"contents": "read", "pull-requests": "write"})

    def test_pr_fields_only_reach_shell_through_env(self):
        for t in self.texts.values():
            for bad in ("github.event.pull_request.title", "github.event.pull_request.body",
                        "github.event.pull_request.head.ref"):
                self.assertNotIn("${{ " + bad, t, f"{bad} interpolated into a shell script")

    def test_fork_and_non_owner_handled_in_script_not_by_skipping(self):
        # Ineligible PRs still report the required check, so the gate cannot silently disappear.
        job = self.gate["jobs"]["classify"]
        self.assertNotIn("if", job)
        self.assertEqual(job["name"], "PR review and merge gate")


class ClassifierTests(Harness):
    def test_ordinary_change_enables_auto_merge_bound_to_head(self):
        self.fixtures(files_list=files(("docs/guide.md", "", "modified")))
        res = self.gate()
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertTrue(self.enabled())
        self.assert_no_merge_endpoint()

    def test_gate_edits_its_own_workflow_is_sensitive(self):
        self.fixtures(files_list=files((".github/workflows/jnibarger01-pr-review-merge.yml", "", "modified")),
                      pr_obj=pr(changed=1))
        res = self.gate()
        self.assertEqual(res.returncode, 0)
        self.assertFalse(self.enabled())
        self.assertTrue(self.disabled())

    def test_sensitive_paths_never_auto_merge(self):
        for path in (".github/workflows/check.yml", "CODEOWNERS", "vendor/desktop-commander/x.js",
                     "packages/auth/session.ts", "apps/gateway/relay.ts", "packages/policy/rules.ts"):
            with self.subTest(path=path):
                self.setUp()
                self.fixtures(files_list=files((path, "", "modified")))
                self.gate()
                self.assertFalse(self.enabled())
                self.assertTrue(self.disabled())

    def test_source_code_never_auto_merges_even_with_ordinary_names(self):
        for path in ("packages/x/index.ts", "apps/web/handler.ts", "packages/checkout/util.ts",
                     "packages/x/service.ts"):
            with self.subTest(path=path):
                self.setUp()
                self.fixtures(files_list=files((path, "", "modified")))
                self.gate()
                self.assertFalse(self.enabled(), f"{path} must need a human")
                self.assertTrue(self.disabled())

    def test_unclassified_path_is_sensitive_by_default(self):
        self.fixtures(files_list=files(("tsconfig.json", "", "modified")))
        self.gate()
        self.assertFalse(self.enabled())
        self.assertTrue(self.disabled())

    def test_rename_out_of_protected_path_is_still_sensitive(self):
        self.fixtures(files_list=files(("docs/moved.md", ".github/workflows/check.yml", "renamed")))
        self.gate()
        self.assertFalse(self.enabled())
        self.assertTrue(self.disabled())

    def test_incomplete_file_list_fails_closed(self):
        self.fixtures(pr_obj=pr(changed=3), files_list=files(("packages/a.ts", "", "modified")))
        self.assert_blocked(self.gate())

    def test_file_api_failure_fails_closed(self):
        self.fixtures()
        (self.fix / "files.json").unlink()  # stub will emit nothing useful; force parse failure below
        (self.fix / "files.json").write_text("not json")
        res = self.gate()
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(self.enabled())

    def test_head_moved_since_event_blocks(self):
        self.fixtures(pr_obj=pr(head=OTHER))
        self.assert_blocked(self.gate())

    def test_missing_integration_binding_blocks_current_main(self):
        self.fixtures(rules=CURRENT_RULES)
        res = self.gate()
        self.assert_blocked(res)
        self.assertIn("not bound to an app", res.stderr)

    def test_missing_review_protection_blocks(self):
        self.fixtures(rules=[GOOD_RULES[0]])
        self.assert_blocked(self.gate())

    def test_missing_actions_attestation_blocks(self):
        self.fixtures()
        self.assert_blocked(self.gate(attested=False))

    def test_draft_fork_and_non_owner_do_not_enable(self):
        for obj in (pr(draft=True), pr(head_repo="someone/fork"), pr(author="someone-else")):
            with self.subTest(pr=obj):
                self.setUp()
                self.fixtures(pr_obj=obj)
                res = self.gate()
                self.assertEqual(res.returncode, 0, res.stderr)
                self.assertFalse(self.enabled())
                self.assert_no_merge_endpoint()

    def test_closed_pr_does_nothing(self):
        self.fixtures(pr_obj=pr(state="closed"))
        res = self.gate()
        self.assertEqual(res.returncode, 0)
        self.assertFalse(self.enabled())

    def test_token_value_never_reaches_stub_arguments(self):
        self.fixtures()
        self.gate()
        self.assertNotIn(GITHUB_TOKEN, self.log.read_text())


class DependabotTests(Harness):
    DEP_ENV = {"UPDATE_TYPE": "version-update:semver-patch", "PR_LABELS": ""}

    def dep(self, **extra):
        env = dict(self.DEP_ENV); env.update(extra)
        return self.run_step(DEPENDABOT, "Classify and enable auto-merge", extra_env=env)

    def test_patch_manifest_bump_enables_auto_merge(self):
        self.fixtures(files_list=files(("package.json", "", "modified"), ("package-lock.json", "", "modified")),
                      pr_obj=pr(author="dependabot[bot]", changed=2))
        res = self.dep()
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertTrue(self.enabled())
        self.assert_no_merge_endpoint()

    def test_major_update_never_enables(self):
        self.fixtures(files_list=files(("package.json", "", "modified")), pr_obj=pr(author="dependabot[bot]"))
        self.dep(UPDATE_TYPE="version-update:semver-major")
        self.assertFalse(self.enabled())
        self.assertTrue(self.disabled())

    def test_parked_label_never_enables(self):
        self.fixtures(files_list=files(("package.json", "", "modified")), pr_obj=pr(author="dependabot[bot]"))
        self.dep(PR_LABELS="deps-parked")
        self.assertFalse(self.enabled())

    def test_source_change_in_dependabot_pr_never_enables(self):
        self.fixtures(files_list=files(("packages/x/index.ts", "", "modified")), pr_obj=pr(author="dependabot[bot]"))
        self.dep()
        self.assertFalse(self.enabled())
        self.assertTrue(self.disabled())

    def test_unknown_update_type_blocks(self):
        self.fixtures(pr_obj=pr(author="dependabot[bot]"))
        res = self.dep(UPDATE_TYPE="")
        self.assert_blocked(res)

    def test_protections_unverified_block(self):
        self.fixtures(rules=CURRENT_RULES, pr_obj=pr(author="dependabot[bot]"),
                      files_list=files(("package.json", "", "modified")))
        self.assert_blocked(self.dep())


if __name__ == "__main__":
    unittest.main()
