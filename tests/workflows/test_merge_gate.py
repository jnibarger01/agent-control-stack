"""Regression tests for the PR merge gate workflows.

Static tests read the workflow YAML. Behavioral tests run the real step
scripts under bash against a stub `gh` that records every call and never
reaches GitHub. Run: python3 -m unittest tests/workflows/test_merge_gate.py
Requires PyYAML.
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
HEAD = "a" * 40
OTHER_HEAD = "b" * 40
REPO = "jnibarger01/agent-control-stack"
GITHUB_TOKEN = "github-token-value-not-real"
MERGE_TOKEN = "merge-token-value-not-real"

STUB = r'''#!/usr/bin/env bash
label=github
[[ -n "${MERGE_TOKEN:-}" && "${GH_TOKEN:-}" == "$MERGE_TOKEN" ]] && label=merge
args="$*"
echo "$label | $args" >> "$STUB_LOG"
jq_filter=""; prev=""
for a in "$@"; do [[ "$prev" == "--jq" ]] && jq_filter="$a"; prev="$a"; done
emit() { if [[ -n "$jq_filter" ]]; then jq -r "$jq_filter"; else cat; fi; }
case "$args" in
  *"pr edit"*) if [[ "${STUB_COPILOT:-unavailable}" == ok ]]; then exit 0; fi; echo "copilot unavailable" >&2; exit 1 ;;
  *graphql*) emit < "$STUB_FIX/snapshot.json" ;;
  *"/merge"*) if [[ "${STUB_MERGE_RC:-0}" == 0 ]]; then emit < "$STUB_FIX/merge_resp.json"; else emit < "$STUB_FIX/merge_resp.json"; exit 1; fi ;;
  *"/files"*) emit < "$STUB_FIX/files.json" ;;
  *"/comments"*"-X PATCH"*|*"/comments"*"-X POST"*) echo '{}' ;;
  *"/comments"*) echo "" ;;
  *"/pulls/"*)
    n=$(cat "$STUB_FIX/pr_calls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_FIX/pr_calls"
    if [[ "$n" -eq 1 ]]; then emit < "$STUB_FIX/pr_first.json"; else emit < "$STUB_FIX/pr_second.json"; fi ;;
  *) echo '{"allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":true}' | emit ;;
esac
'''


def pr_json(author="jnibarger01", draft=False, head=HEAD, mergeable=True):
    return {"state": "open", "user": {"login": author}, "draft": draft,
            "head": {"sha": head}, "mergeable": mergeable}


def snapshot(mergeable="MERGEABLE", review="NONE", head=HEAD, threads=None, checks=None):
    checks = checks if checks is not None else [
        {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"}]
    return {"data": {"repository": {"pullRequest": {
        "state": "OPEN", "isDraft": False, "mergeable": mergeable,
        "reviewDecision": None if review == "NONE" else review, "headRefOid": head,
        "reviews": {"nodes": []},
        "reviewThreads": {"nodes": threads or [], "pageInfo": {"hasNextPage": False}},
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {
            "nodes": checks, "pageInfo": {"hasNextPage": False}}}}}]},
    }}}}


def load_steps(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))["jobs"]


class StaticGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gate = load_steps(GATE)["review-and-merge"]
        cls.dep = load_steps(DEPENDABOT)["dependabot"]

    def steps(self):
        return self.gate["steps"]

    def test_dispatch_only_from_main(self):
        cond = self.gate["if"]
        self.assertIn("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'", cond)
        # Without the ref guard, a dispatch from any branch would run that branch's gate.
        self.assertNotIn("github.event_name == 'workflow_dispatch' ||", cond)

    def test_token_minted_only_after_gate_writes_ready(self):
        names = [s.get("name", "") for s in self.steps()]
        mint_idx = next(i for i, s in enumerate(self.steps()) if s.get("id") == "merge-token")
        gate_idx = next(i for i, s in enumerate(self.steps()) if s.get("id") == "gate")
        self.assertLess(gate_idx, mint_idx)
        self.assertEqual(self.steps()[mint_idx]["if"], "steps.gate.outputs.gate_ready == 'true'")
        self.assertEqual(names[-1], "Merge")

    def test_gate_step_never_sees_app_key_or_merge_token(self):
        gate = self.steps()[0]
        self.assertNotIn("MERGE_TOKEN", gate.get("env", {}))
        self.assertNotIn("ACS_MERGE_APP_PRIVATE_KEY", json.dumps(gate))
        self.assertNotIn("merge-token", json.dumps(gate))

    def test_only_merge_step_uses_merge_token_and_put(self):
        for step in self.steps():
            text = json.dumps(step)
            if step.get("name") == "Merge":
                self.assertIn("steps.merge-token.outputs.token", text)
                self.assertIn('GH_TOKEN="$MERGE_TOKEN" gh api', step["run"])
                self.assertEqual(step["run"].count("-X PUT"), 1)
            else:
                self.assertNotIn("steps.merge-token", text)
                self.assertNotIn("-X PUT", step.get("run", ""))

    def test_no_merge_mint_or_put_without_gate_ready(self):
        for step in self.steps():
            if step.get("name") in ("Merge", "Mint merge token (GitHub App)"):
                self.assertEqual(step["if"], "steps.gate.outputs.gate_ready == 'true'")

    def test_dependabot_mints_only_after_credential_check_and_gate(self):
        names = [s.get("name", "") for s in self.dep["steps"]]
        check = names.index("Verify merge App credentials are configured")
        mint = names.index("Mint merge token (GitHub App)")
        self.assertLess(check, mint)
        self.assertIn("steps.gate.outputs.blocked != 'true'", self.dep["steps"][mint]["if"])
        enable = self.dep["steps"][-1]
        self.assertEqual(enable["env"]["GH_TOKEN"], "${{ steps.merge-token.outputs.token }}")


class GateBehaviourTests(unittest.TestCase):
    """Runs the real review-gate script against the stub gh."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="merge-gate-test-"))
        self.fix = self.tmp / "fix"
        self.fix.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "gh").write_text(STUB, encoding="utf-8")
        (self.bin / "gh").chmod(0o755)
        self.log = self.tmp / "calls.log"
        self.out = self.tmp / "github_output"
        self.out.write_text("")
        self.run_script = load_steps(GATE)["review-and-merge"]["steps"][0]["run"]
        self.merge_script = [s for s in load_steps(GATE)["review-and-merge"]["steps"]
                             if s.get("name") == "Merge"][0]["run"]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, obj):
        (self.fix / name).write_text(json.dumps(obj), encoding="utf-8")

    def fixtures(self, pr_first=None, pr_second=None, snap=None, files=None, merge_resp=None):
        self.write("pr_first.json", pr_first or pr_json())
        self.write("pr_second.json", pr_second or pr_json())
        self.write("snapshot.json", snap or snapshot())
        self.write("files.json", files if files is not None else [])
        self.write("merge_resp.json", merge_resp or {"merged": True})

    def env(self, merge_rc=0, copilot="unavailable", pr_number="406", extra=None):
        e = dict(os.environ)
        e.update({
            "PATH": f"{self.bin}:{e['PATH']}",
            "STUB_LOG": str(self.log), "STUB_FIX": str(self.fix),
            "STUB_MERGE_RC": str(merge_rc), "STUB_COPILOT": copilot,
            "GITHUB_REPOSITORY": REPO, "PR_NUMBER": pr_number,
            "GH_TOKEN": GITHUB_TOKEN, "MERGE_TOKEN": MERGE_TOKEN,
            "GITHUB_OUTPUT": str(self.out), "HEAD_SHA": HEAD, "METHOD": "squash",
        })
        e.update(extra or {})
        return e

    def run_bash(self, script, env):
        p = self.tmp / "step.sh"
        p.write_text(script, encoding="utf-8")
        return subprocess.run(["bash", str(p)], env=env, capture_output=True, text=True, timeout=120)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def outputs(self):
        return self.out.read_text()

    def gate_ready(self):
        return "gate_ready=true" in self.outputs()

    def assert_blocked(self, res):
        self.assertNotEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertFalse(self.gate_ready(), "BLOCK must not write gate_ready")
        self.assertFalse(any("-X PUT" in c for c in self.calls()),
                         "BLOCK must not invoke the merge API")

class GateTests(GateBehaviourTests):
    def test_happy_path_passes_gate_without_merging(self):
        self.fixtures()
        res = self.run_bash(self.run_script, self.env())
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertTrue(self.gate_ready())
        self.assertIn(f"head_sha={HEAD}", self.outputs())
        self.assertFalse(any("-X PUT" in c for c in self.calls()), "gate step must not merge")

    def test_conflicting_pr_blocks(self):
        self.fixtures(snap=snapshot(mergeable="CONFLICTING"))
        self.assert_blocked(self.run_bash(self.run_script, self.env()))

    def test_changes_requested_blocks(self):
        self.fixtures(snap=snapshot(review="CHANGES_REQUESTED"))
        self.assert_blocked(self.run_bash(self.run_script, self.env()))

    def test_failed_check_blocks(self):
        self.fixtures(snap=snapshot(checks=[
            {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE"}]))
        self.assert_blocked(self.run_bash(self.run_script, self.env()))

    def test_unresolved_thread_blocks(self):
        threads = [{"isResolved": False, "comments": {"nodes": []}}]
        self.fixtures(snap=snapshot(threads=threads))
        self.assert_blocked(self.run_bash(self.run_script, self.env()))

    def test_head_moved_during_review_blocks(self):
        self.fixtures(pr_second=pr_json(head=OTHER_HEAD))
        self.assert_blocked(self.run_bash(self.run_script, self.env()))

    def test_policy_file_self_modification_blocks(self):
        self.fixtures(files=[{"filename": ".github/workflows/jnibarger01-pr-review-merge.yml"}])
        self.assert_blocked(self.run_bash(self.run_script, self.env()))

    def test_non_owner_pr_is_ignored_without_merge_readiness(self):
        self.fixtures(pr_first=pr_json(author="someone-else"), pr_second=pr_json(author="someone-else"))
        res = self.run_bash(self.run_script, self.env())
        self.assertEqual(res.returncode, 0)
        self.assertFalse(self.gate_ready())

    def test_draft_pr_is_ignored(self):
        self.fixtures(pr_first=pr_json(draft=True))
        res = self.run_bash(self.run_script, self.env())
        self.assertEqual(res.returncode, 0)
        self.assertFalse(self.gate_ready())

    def test_missing_mergeable_on_final_read_blocks(self):
        self.fixtures(pr_second=pr_json(mergeable=False))
        self.assert_blocked(self.run_bash(self.run_script, self.env()))


class MergeStepTests(GateBehaviourTests):
    """Runs the real Merge step script."""

    def test_merge_uses_app_token_only_for_put(self):
        self.fixtures(merge_resp={"merged": True})
        res = self.run_bash(self.merge_script, self.env())
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        puts = [c for c in self.calls() if "-X PUT" in c]
        self.assertEqual(len(puts), 1)
        self.assertTrue(puts[0].startswith("merge |"), puts[0])
        reads = [c for c in self.calls() if "-X PUT" not in c and " | " in c]
        self.assertTrue(all(c.startswith("github |") for c in reads), reads)
        self.assertNotIn(MERGE_TOKEN, self.log.read_text())

    def test_merge_pins_reviewed_head_sha(self):
        self.fixtures()
        self.run_bash(self.merge_script, self.env())
        put = [c for c in self.calls() if "-X PUT" in c][0]
        self.assertIn(f"sha={HEAD}", put)

    def test_rejected_merge_blocks_and_comments_without_token_value(self):
        self.fixtures(merge_resp={"message": "Pull Request is not mergeable"})
        res = self.run_bash(self.merge_script, self.env(merge_rc=1))
        self.assertNotEqual(res.returncode, 0)
        comments = [c for c in self.calls() if "/comments" in c and "-X POST" in c]
        self.assertTrue(comments, "rejected merge must post a BLOCK comment")
        self.assertNotIn(MERGE_TOKEN, self.log.read_text())

    def test_merged_false_blocks(self):
        self.fixtures(merge_resp={"merged": False, "message": "nope"})
        res = self.run_bash(self.merge_script, self.env(merge_rc=0))
        self.assertNotEqual(res.returncode, 0)


if __name__ == "__main__":
    unittest.main()
