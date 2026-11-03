"""Hotfix regression tests: the merge gate on main can no longer merge or enable auto-merge.

Run: python3 -m unittest tests/workflows/test_hotfix_gate_disabled.py   (needs PyYAML)
"""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / ".github/workflows/jnibarger01-pr-review-merge.yml"
DEP = ROOT / ".github/workflows/dependabot-auto-merge.yml"
FORBIDDEN = ["gh pr merge", "--auto", "-X PUT", "/merge", "create-github-app-token",
             "secrets.", "workflow_dispatch", "--admin", "enablePullRequestAutoMerge"]


class GateDisabled(unittest.TestCase):
    def setUp(self):
        self.text = GATE.read_text()
        self.doc = yaml.safe_load(self.text)

    def test_no_merge_or_auto_merge_capability(self):
        for token in FORBIDDEN:
            self.assertNotIn(token, self.text, f"gate still contains {token!r}")

    def test_no_secrets_and_read_only_token(self):
        self.assertEqual(self.doc["permissions"], {"contents": "read"})

    def test_keeps_required_check_name_and_fails_closed(self):
        job = self.doc["jobs"]["review-and-merge"]
        self.assertEqual(job["name"], "PR review and merge gate")
        self.assertIn("exit 1", job["steps"][0]["run"])

    def test_gate_script_exits_nonzero_and_makes_no_github_calls(self):
        script = self.doc["jobs"]["review-and-merge"]["steps"][0]["run"]
        with tempfile.TemporaryDirectory() as tmp:
            stub = Path(tmp) / "gh"
            calls = Path(tmp) / "calls"
            stub.write_text(f'#!/usr/bin/env bash\necho "$*" >> "{calls}"\n')
            stub.chmod(0o755)
            env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}")
            res = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("disabled", res.stderr)
            self.assertFalse(calls.exists(), "disabled gate must not call gh")


class DependabotDisabled(unittest.TestCase):
    def setUp(self):
        self.text = DEP.read_text()
        self.doc = yaml.safe_load(self.text)

    def test_job_can_never_run(self):
        self.assertEqual(str(self.doc["jobs"]["dependabot"]["if"]).strip(), "${{ false }}")
        self.assertEqual(self.doc["permissions"], {"contents": "read"})

    def test_no_merge_or_credential_path_remains(self):
        for token in FORBIDDEN:
            self.assertNotIn(token, self.text, f"dependabot workflow still contains {token!r}")


if __name__ == "__main__":
    unittest.main()
