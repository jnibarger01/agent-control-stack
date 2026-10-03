#!/usr/bin/env python3
"""Keep the installed Nimble routing model resident in local Ollama."""

import json
import sys
import time
from datetime import datetime, timezone
from urllib.error import URLError
from urllib.request import Request, urlopen


BASE_URL = "http://127.0.0.1:11434"
MODEL = "nimble:latest"
READY_TIMEOUT_SECONDS = 180
CHECK_INTERVAL_SECONDS = 60


def request_json(path: str, payload: dict | None = None, timeout: float = 5) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        f"{BASE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def wait_until_ready() -> None:
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    while True:
        try:
            request_json("/api/version", timeout=3)
            return
        except (OSError, URLError, TimeoutError):
            if time.monotonic() >= deadline:
                raise RuntimeError("Ollama API did not become ready within 180 seconds")
            time.sleep(3)


def nimble_is_pinned(models: list[dict]) -> bool:
    for model in models:
        if model.get("name") != MODEL or model.get("size", 0) <= 0:
            continue
        expires_at = model.get("expires_at")
        if not isinstance(expires_at, str):
            return False
        try:
            expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            return False
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        return (expiry - datetime.now(timezone.utc)).total_seconds() > 365 * 24 * 60 * 60
    return False


def ensure_resident() -> None:
    wait_until_ready()
    tags = request_json("/api/tags")
    installed = {model.get("name") for model in tags.get("models", [])}
    if MODEL not in installed:
        raise RuntimeError(f"{MODEL} is not installed; refusing to pull models automatically")
    running = request_json("/api/ps").get("models", [])
    if nimble_is_pinned(running):
        return
    other_models = [
        model.get("name") for model in running
        if model.get("name") != MODEL and model.get("size", 0) > 0
    ]
    if other_models:
        raise RuntimeError(
            "preserving other resident Ollama model(s); retrying Nimble when capacity is free"
        )

    # Bound the warm-up to one token; routing inference uses its separate endpoint.
    request_json(
        "/api/generate",
        {
            "model": MODEL,
            "prompt": "",
            "stream": False,
            "keep_alive": -1,
            "options": {"num_predict": 1},
        },
        timeout=240,
    )
    if not nimble_is_pinned(request_json("/api/ps").get("models", [])):
        raise RuntimeError(
            "Ollama did not report nimble:latest as pinned after the keep-alive request"
        )


def main() -> int:
    while True:
        try:
            ensure_resident()
            print("nimble:latest is resident and pinned", flush=True)
        except (OSError, URLError, TimeoutError, ValueError, RuntimeError) as error:
            print(f"Nimble residency check failed: {error}", file=sys.stderr, flush=True)
        time.sleep(CHECK_INTERVAL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
