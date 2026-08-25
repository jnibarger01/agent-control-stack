#!/usr/bin/env python3
import hashlib, json, os, sqlite3, sys, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

CATS = ("feature", "bugfix", "security", "architecture", "refactor", "tests", "docs")
DB, RESULT = Path(".automation/state/tasks.db"), Path(".automation/runtime-result.json")


def need(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"missing {name}")
    return value


def api(path):
    req = urllib.request.Request(
        f"https://api.github.com/{path.lstrip('/')}",
        headers={"Authorization": f"Bearer {need('GITHUB_TOKEN')}",
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "hourly-pr-worker"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def pages(path):
    out, page, sep = [], 1, "&" if "?" in path else "?"
    while True:
        batch = api(f"{path}{sep}per_page=100&page={page}")
        out += batch
        if len(batch) < 100:
            return out
        page += 1


def dbopen():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB)
    db.execute("""CREATE TABLE IF NOT EXISTS tasks(
      idempotency_key TEXT PRIMARY KEY, repo TEXT NOT NULL, category TEXT NOT NULL,
      title TEXT NOT NULL, source_type TEXT, source_ref TEXT, priority INTEGER NOT NULL,
      confidence REAL NOT NULL, risk_level TEXT NOT NULL, evidence TEXT,
      acceptance_criteria TEXT, estimated_files INTEGER, estimated_diff_lines INTEGER,
      status TEXT NOT NULL, branch TEXT, commit_sha TEXT, pr_number INTEGER, pr_url TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
    db.commit()
    return db


def output(name, value):
    with open(need("GITHUB_OUTPUT"), "a", encoding="utf-8") as f:
        f.write(f"{name}={value}\n")


def dt(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def preflight():
    repo, now = need("GITHUB_REPOSITORY"), datetime.now(timezone.utc)
    cycle = now.strftime("%Y%m%d-%H")
    category = CATS[int(now.timestamp() // 3600) % len(CATS)]
    default = api(f"repos/{repo}")["default_branch"]
    open_auto = [p for p in pages(f"repos/{repo}/pulls?state=open")
                 if p["head"]["ref"].startswith("auto/")]

    hour = now.replace(minute=0, second=0, microsecond=0)
    recent = api(f"repos/{repo}/pulls?state=all&sort=created&direction=desc&per_page=100")
    made_this_hour = [p for p in recent if p["head"]["ref"].startswith("auto/")
                      and dt(p["created_at"]) >= hour]

    runs = api(f"repos/{repo}/actions/runs?branch={urllib.parse.quote(default, safe='')}&status=completed&per_page=20")
    latest = next((r.get("conclusion") for r in runs.get("workflow_runs", [])
                   if r.get("event") in {"push", "workflow_dispatch"}), "unknown")

    if made_this_hour:
        mode, reason = "skip", "automated PR already created in this UTC hour"
    elif len(open_auto) >= 5:
        mode, reason = "maintenance", "open automated PR backlog reached 5"
    else:
        mode, reason = "create", "eligible for candidate selection"

    key = hashlib.sha256(f"{repo}:{cycle}".encode()).hexdigest()
    evidence = {"cycle_id": cycle, "mode": mode, "reason": reason,
                "open_automated_prs": len(open_auto), "latest_default_branch_ci": latest,
                "default_branch": default}
    stamp = now.isoformat()
    db = dbopen()
    db.execute("""INSERT INTO tasks(idempotency_key,repo,category,title,priority,confidence,
      risk_level,evidence,acceptance_criteria,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(idempotency_key) DO UPDATE SET evidence=excluded.evidence,
      status=excluded.status,updated_at=excluded.updated_at""",
      (key, repo, category, f"Hourly evaluation {cycle}", 5, 1.0, "LOW",
       json.dumps(evidence), "[]", "skipped" if mode == "skip" else "reserved", stamp, stamp))
    db.commit(); db.close()

    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps({**evidence, "idempotency_key": key, "repo": repo,
                                  "category": category,
                                  "status": "skipped" if mode == "skip" else "planning"}, indent=2))
    for k, v in {"idempotency_key": key, "cycle_id": cycle, "category": category,
                 "mode": mode, "reason": reason, "open_automated_prs": len(open_auto),
                 "default_branch": default, "latest_main_ci": latest}.items():
        output(k, str(v))
    print(json.dumps(evidence, indent=2))


def reconcile():
    repo, key = need("GITHUB_REPOSITORY"), need("IDEMPOTENCY_KEY")
    mode, outcome = os.environ.get("CYCLE_MODE", ""), os.environ.get("ACTION_OUTCOME", "")
    try:
        result = json.loads(RESULT.read_text()) if RESULT.exists() else {}
    except json.JSONDecodeError:
        result = {"status": "failed", "reason": "invalid runtime-result JSON"}

    cycle = result.get("cycle_id") or need("CYCLE_ID")
    start = datetime.strptime(cycle, "%Y%m%d-%H").replace(tzinfo=timezone.utc)
    recent = api(f"repos/{repo}/pulls?state=all&sort=created&direction=desc&per_page=100")
    created = [p for p in recent if p["head"]["ref"].startswith("auto/")
               and dt(p["created_at"]) >= start]

    if len(created) > 1:
        status, result["reason"] = "failed", "safety violation: >1 automated PR in cycle"
    elif created:
        p, status = created[0], "pr_open"
        result.update(branch=p["head"]["ref"], pr_number=p["number"], pr_url=p["html_url"])
    elif outcome == "failure":
        status = "failed"
    elif mode == "maintenance" and outcome == "success":
        status = result.get("status") if result.get("status") in {"completed","blocked","failed","escalated"} else "completed"
    elif mode == "skip":
        status = "skipped"
    else:
        status = result.get("status") if result.get("status") in {"skipped","blocked","failed","escalated"} else "skipped"

    result["status"] = status
    evidence = result.get("evidence") if isinstance(result.get("evidence"), dict) else {}
    evidence.update(action_outcome=outcome or "skipped", mode=mode,
                    reconciled_at=datetime.now(timezone.utc).isoformat())
    criteria = result.get("acceptance_criteria") or []
    if not isinstance(criteria, list):
        criteria = [str(criteria)]

    db = dbopen()
    db.execute("""UPDATE tasks SET title=?,source_type=?,source_ref=?,risk_level=?,
      evidence=?,acceptance_criteria=?,status=?,branch=?,pr_number=?,pr_url=?,updated_at=?
      WHERE idempotency_key=?""",
      (result.get("title") or f"Hourly evaluation {cycle}", result.get("source_type"),
       result.get("source_ref"), str(result.get("risk_level") or "LOW").upper(),
       json.dumps(evidence), json.dumps(criteria), status, result.get("branch"),
       result.get("pr_number"), result.get("pr_url"), datetime.now(timezone.utc).isoformat(), key))
    db.commit(); db.close()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"preflight", "reconcile"}:
        raise SystemExit("usage: hourly_pr.py <preflight|reconcile>")
    preflight() if sys.argv[1] == "preflight" else reconcile()
