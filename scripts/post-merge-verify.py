#!/usr/bin/env python3
"""Read-only post-merge verification of a commit on main.

GITHUB_TOKEN merges do not start push workflows, so nothing re-checks main after an
unattended merge. This script asks GitHub what check runs exist for one commit and
reports whether every required check concluded SUCCESS. It can read and report. It
cannot merge, approve, comment, dispatch a workflow, or change repository settings.

It is not wired to any workflow trigger. Activation is a separate, reviewed change.

Usage: post-merge-verify.py --repo OWNER/NAME --sha FULL_SHA [--require NAME ...]
Exit: 0 when every required check succeeded on that exact SHA; 1 otherwise.
"""
import argparse
import json
import re
import subprocess
import sys

SHA = re.compile(r"^[0-9a-f]{40}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
DEFAULT_REQUIRED = ["check", "test", "Execution-chain E2E (ACS -> gateway/relay -> DC)"]


def check_runs(repo: str, sha: str) -> list[dict]:
    """GET-only call for check runs on the commit. The fixed argument list has no write method."""
    out = subprocess.run(
        ["gh", "api", "--paginate", f"repos/{repo}/commits/{sha}/check-runs?per_page=100", "--jq", ".check_runs[]"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def evaluate(runs: list[dict], required: list[str]) -> tuple[bool, list[str]]:
    """Returns (ok, problems). A required name with no completed SUCCESS run on this SHA is a problem."""
    problems = []
    for name in required:
        matching = [r for r in runs if r.get("name") == name]
        if not matching:
            problems.append(f"missing: {name}")
            continue
        latest = max(matching, key=lambda r: r.get("id", 0))
        if latest.get("status") != "completed":
            problems.append(f"not completed: {name}")
        elif latest.get("conclusion") != "success":
            problems.append(f"{latest.get('conclusion')}: {name}")
    return (not problems, problems)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--require", nargs="*", default=None)
    args = parser.parse_args(argv)
    if not REPO.match(args.repo):
        print("BLOCK: repo must be OWNER/NAME", file=sys.stderr)
        return 1
    if not SHA.match(args.sha):
        print("BLOCK: sha must be a full 40-character lowercase commit id", file=sys.stderr)
        return 1
    required = args.require if args.require else DEFAULT_REQUIRED
    try:
        runs = check_runs(args.repo, args.sha)
    except (subprocess.CalledProcessError, json.JSONDecodeError) as err:
        print(f"BLOCK: could not read check runs ({type(err).__name__})", file=sys.stderr)
        return 1
    ok, problems = evaluate(runs, required)
    if ok:
        print(f"OK: all {len(required)} required checks succeeded on {args.sha}")
        return 0
    for problem in problems:
        print(f"BLOCK: {problem}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
