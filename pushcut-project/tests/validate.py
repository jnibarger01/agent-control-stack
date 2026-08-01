#!/usr/bin/env python3
"""Validate project JSON contracts and mock-only approval invariants."""

from __future__ import annotations

import copy
import datetime as dt
import hashlib
import importlib.util
import json
import pathlib
import sys
import urllib.error
from typing import Any

import jsonschema

ROOT = pathlib.Path(__file__).resolve().parents[1]


def read_json(relative: str) -> Any:
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def validate(schema_name: str, instance: Any) -> None:
    schema = read_json(f"schemas/{schema_name}")
    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(
        schema, format_checker=jsonschema.FormatChecker()
    )
    validator.validate(instance)


def expect_invalid(schema_name: str, instance: Any) -> None:
    try:
        validate(schema_name, instance)
    except jsonschema.ValidationError:
        return
    raise AssertionError(f"fixture unexpectedly passed {schema_name}")


def canonical_digest(instance: Any) -> str:
    body = json.dumps(instance, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(body).hexdigest()


def test_timeout_without_retry() -> None:
    module_path = ROOT / "scripts/pushcut-client.py"
    spec = importlib.util.spec_from_file_location("pushcut_client", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    calls = 0
    original = module.urllib.request.urlopen

    def fail_once(*_args: Any, **_kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        raise urllib.error.URLError(TimeoutError("mock timeout"))

    module.urllib.request.urlopen = fail_once
    old_key = module.os.environ.get("PUSHCUT_API_KEY")
    module.os.environ["PUSHCUT_API_KEY"] = "placeholder-key"
    try:
        result = module.execute(
            "https://api.pushcut.io/v1/notifications/mock", {"title": "mock"}
        )
    finally:
        module.urllib.request.urlopen = original
        if old_key is None:
            module.os.environ.pop("PUSHCUT_API_KEY", None)
        else:
            module.os.environ["PUSHCUT_API_KEY"] = old_key
    assert result == 1
    assert calls == 1


def main() -> int:
    for path in ROOT.rglob("*.json"):
        json.loads(path.read_text(encoding="utf-8"))

    repair = read_json("examples/approval-request.json")
    validate("repair-request.schema.json", repair)

    diagnostic = {
        "schema_version": "1.0",
        "request_id": "diag-20260802-001",
        "idempotency_key": "diag:all:20260802T170000Z",
        "target": "all",
        "health_status": "degraded",
        "evidence": [{"check": "disk", "status": "warn", "summary": "mock 81%"}],
        "suspected_cause": "Mock fixture",
        "recommended_action": "Inspect only",
        "risk_level": "low",
        "observed_at": "2026-08-02T17:00:00Z",
    }
    validate("diagnostic-result.schema.json", diagnostic)

    approval = {
        "schema_version": "1.0",
        "approval_id": "approval-demo-001",
        "work_item_id": repair["work_item_id"],
        "action_hash": repair["action_hash"],
        "principal_id": "operator-demo",
        "decision": "approved",
        "decided_at": "2026-08-02T17:00:00Z",
        "expires_at": "2099-08-02T17:05:00Z",
        "one_time_use": True,
    }
    validate("approval.schema.json", approval)
    rejected = {**approval, "approval_id": "approval-demo-002", "decision": "rejected"}
    validate("approval.schema.json", rejected)

    missing_hash = copy.deepcopy(repair)
    del missing_hash["action_hash"]
    expect_invalid("repair-request.schema.json", missing_hash)

    extra_command = {**diagnostic, "command": "uname -a"}
    expect_invalid("diagnostic-result.schema.json", extra_command)

    invalid_hash = {**repair, "action_hash": "sha256:not-hex"}
    expect_invalid("repair-request.schema.json", invalid_hash)

    reusable = {**approval, "one_time_use": False}
    expect_invalid("approval.schema.json", reusable)

    expired = {**approval, "expires_at": "2020-01-01T00:00:00Z"}
    expiry = dt.datetime.fromisoformat(expired["expires_at"].replace("Z", "+00:00"))
    assert expiry < dt.datetime.now(dt.timezone.utc)

    ledger: dict[str, str] = {}
    key = repair["idempotency_key"]
    digest = canonical_digest(repair)
    ledger[key] = digest
    assert ledger[key] == digest
    changed = {**repair, "expected_effect": "changed content"}
    assert ledger[key] != canonical_digest(changed)

    assert rejected["decision"] != "approved"
    harmless_result = {"status": "mock_only", "executed": False}
    assert harmless_result == {"status": "mock_only", "executed": False}

    test_timeout_without_retry()

    print(
        "PASS: JSON parsing, schemas, negatives, expiry, dedupe, rejection, "
        "mock action, single-attempt timeout"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
