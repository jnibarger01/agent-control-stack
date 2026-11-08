"""Tests for scripts/post-merge-verify.py. `gh` is replaced by a stub on PATH, so no GitHub call is made.

The stub records every argument it receives. The verifier must never send a write method, a
dispatch, a merge, or a comment.
"""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/post-merge-verify.py"
SHA = "a" * 40
REPO = "jnibarger01/agent-control-stack"
REQUIRED = ["check", "test"]

STUB = r'''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
if [[ -n "${STUB_FAIL:-}" ]]; then echo "boom" >&2; exit 1; fi
cat "$STUB_RUNS"
'''


def run(runs_text, args, fail=False):
    with tempfile.TemporaryDirectory() as tmp:
        bindir = Path(tmp) / "bin"
        bindir.mkdir()
        gh = bindir / "gh"
        gh.write_text(STUB)
        gh.chmod(0o755)
        runs = Path(tmp) / "runs.jsonl"
        runs.write_text(runs_text)
        log = Path(tmp) / "calls.log"
        log.write_text("")
        env = {
            "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
            "STUB_RUNS": str(runs),
            "STUB_LOG": str(log),
        }
        if fail:
            env["STUB_FAIL"] = "1"
        proc = subprocess.run(
            ["python3", str(SCRIPT), *args], env=env, capture_output=True, text=True
        )
        return proc, log.read_text()


def jsonl(*runs):
    return "\n".join(json.dumps(r) for r in runs) + "\n"


def run_row(rid, name, conclusion="success", status="completed"):
    return {"id": rid, "name": name, "status": status, "conclusion": conclusion}


class PostMergeVerify(unittest.TestCase):
    def args(self, sha=SHA):
        return ["--repo", REPO, "--sha", sha, "--require", *REQUIRED]

    def test_all_required_checks_success_on_the_sha_exits_zero(self):
        proc, _ = run(jsonl(run_row(1, "check"), run_row(2, "test")), self.args())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("OK", proc.stdout)

    def test_a_failed_required_check_blocks(self):
        proc, _ = run(jsonl(run_row(1, "check", "failure"), run_row(2, "test")), self.args())
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("BLOCK: failure: check", proc.stderr)

    def test_a_missing_required_check_blocks(self):
        proc, _ = run(jsonl(run_row(1, "check")), self.args())
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("missing: test", proc.stderr)

    def test_a_check_still_running_blocks(self):
        proc, _ = run(jsonl(run_row(1, "check"), run_row(2, "test", None, "in_progress")), self.args())
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not completed: test", proc.stderr)

    def test_a_newer_failure_overrides_an_older_success(self):
        proc, _ = run(jsonl(run_row(1, "check"), run_row(9, "check", "failure"), run_row(2, "test")), self.args())
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("failure: check", proc.stderr)

    def test_an_unreadable_api_blocks_and_never_reports_ok(self):
        proc, _ = run("", self.args(), fail=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("OK", proc.stdout)
        self.assertIn("could not read check runs", proc.stderr)

    def test_a_short_or_uppercase_sha_is_refused_before_any_call(self):
        for bad in ["abc", "A" * 40, "a" * 39]:
            with self.subTest(sha=bad):
                proc, calls = run(jsonl(run_row(1, "check")), self.args(sha=bad))
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn("BLOCK: sha must be", proc.stderr)
                self.assertEqual(calls, "", "no GitHub call may be made for an invalid sha")

    def test_only_read_calls_are_made_and_no_write_or_merge_flags_are_sent(self):
        _, calls = run(jsonl(run_row(1, "check"), run_row(2, "test")), self.args())
        self.assertTrue(calls.strip(), "the verifier should read check runs")
        for line in calls.splitlines():
            for forbidden in ["--method", "-X", "-f", "-F", "--input", "--field", "pulls", "merge", "dispatches", "comments"]:
                self.assertNotIn(forbidden, line.split(), f"write-capable argument {forbidden!r} in: {line}")
            self.assertIn("check-runs", line)


if __name__ == "__main__":
    unittest.main()
