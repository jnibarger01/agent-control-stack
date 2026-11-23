"""CODEOWNERS must name an owner for .github/.

"Require review from Code Owners" only protects a path that CODEOWNERS covers. The PR merge classifier applies the same
rule to the CODEOWNERS file on main (its grep: ^/?\\.github/(\\*\\*)?[[:space:]]+@owner) and blocks without it, so this
test pins the repository's own file to that rule.

Run: python3 -m unittest tests/workflows/test_codeowners.py
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CODEOWNERS = ROOT / ".github/CODEOWNERS"
# Same rule as the classifier's grep.
GITHUB_DIR_ENTRY = re.compile(r"^/?\.github/(\*\*)?\s+@[A-Za-z0-9_-]")


class CodeownersTests(unittest.TestCase):
    def lines(self):
        return CODEOWNERS.read_text(encoding="utf-8").splitlines()

    def test_github_directory_has_an_owner(self):
        self.assertTrue(
            any(GITHUB_DIR_ENTRY.match(line) for line in self.lines()),
            ".github/CODEOWNERS names no owner for /.github/",
        )

    def test_the_owner_is_the_repository_owner(self):
        entries = [line for line in self.lines() if GITHUB_DIR_ENTRY.match(line)]
        self.assertTrue(entries)
        for entry in entries:
            self.assertIn("@jnibarger01", entry.split())

    def test_existing_sandbox_entries_are_kept(self):
        text = CODEOWNERS.read_text(encoding="utf-8")
        self.assertIn("/packages/sandbox/ @jnibarger01", text)
        self.assertIn("/docs/releases/sandbox-real-execution-gate.md @jnibarger01", text)

    def test_every_rule_line_has_a_pattern_and_an_owner(self):
        for number, line in enumerate(self.lines(), start=1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split()
            self.assertGreaterEqual(len(parts), 2, f"line {number} has no owner: {line!r}")
            for owner in parts[1:]:
                self.assertTrue(owner.startswith("@"), f"line {number}: {owner!r} is not an @owner")


if __name__ == "__main__":
    unittest.main()
