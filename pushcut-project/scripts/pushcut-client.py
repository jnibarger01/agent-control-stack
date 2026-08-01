#!/usr/bin/env python3
"""Dry-run-first Pushcut API client with no third-party dependencies."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

API_BASE = "https://api.pushcut.io/v1"
MAX_PAYLOAD_BYTES = 262_144


def load_payload(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError("payload file not found")
    if path.stat().st_size > MAX_PAYLOAD_BYTES:
        raise ValueError("payload exceeds 256 KiB")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("payload must be a JSON object")
    return value


def build_request(args: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    payload = load_payload(args.payload)
    if args.command == "notify":
        name = urllib.parse.quote(args.notification, safe="")
        return f"{API_BASE}/notifications/{name}", payload

    query: dict[str, str] = {"shortcut": args.shortcut, "timeout": args.timeout}
    return f"{API_BASE}/execute?{urllib.parse.urlencode(query)}", payload


def execute(url: str, payload: dict[str, Any]) -> int:
    api_key = os.environ.get("PUSHCUT_API_KEY", "")
    if not api_key:
        raise ValueError("PUSHCUT_API_KEY is required with --execute")
    if not (8 <= len(api_key) <= 512) or not all(
        char.isalnum() or char in "._-" for char in api_key
    ):
        raise ValueError("PUSHCUT_API_KEY contains unexpected characters")

    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "API-Key": api_key},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            response_body = response.read(MAX_PAYLOAD_BYTES + 1)
            if len(response_body) > MAX_PAYLOAD_BYTES:
                raise ValueError("response exceeds 256 KiB")
            print(f"HTTP {response.status}")
            if response_body:
                print(response_body.decode("utf-8", errors="replace"))
            return 0
    except urllib.error.HTTPError as error:
        response_body = error.read(8_192).decode("utf-8", errors="replace")
        print(f"Pushcut HTTP {error.code}: {response_body}", file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Pushcut request failed: {error.reason}", file=sys.stderr)
        return 1


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument(
        "--execute", action="store_true", help="perform the request; default is dry-run"
    )
    subparsers = root.add_subparsers(dest="command", required=True)

    notify = subparsers.add_parser("notify")
    notify.add_argument("--notification", required=True)
    notify.add_argument("--payload", type=pathlib.Path, required=True)

    run = subparsers.add_parser("execute-shortcut")
    run.add_argument("--shortcut", required=True)
    run.add_argument("--timeout", default="10")
    run.add_argument("--payload", type=pathlib.Path, required=True)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        url, payload = build_request(args)
        if not args.execute:
            print("DRY RUN")
            print("method: POST")
            print(f"endpoint: {url}")
            print(f"payload: {args.payload}")
            print("auth: API-Key from PUSHCUT_API_KEY (not displayed)")
            return 0
        return execute(url, payload)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

