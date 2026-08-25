#!/usr/bin/env python3
"""Bounded, repository-local autonomous coding-agent supervisor.

This is development tooling only. It does not create ACS work items, leases,
attempts, approvals, recovery actions, or publication state.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

ACS_CONTINUE = "<ACS_CONTINUE>"
ACS_MILESTONE_COMPLETE = "<ACS_MILESTONE_COMPLETE>"
ACS_BLOCKED = "<ACS_BLOCKED>"

DEFAULT_MAX_INVOCATIONS = 100
DEFAULT_TIMEOUT_SECONDS = 30 * 60

DEFAULT_AGENT_COMMANDS: dict[str, list[str]] = {
    "codex": ["codex", "exec", "--full-auto", "--skip-git-repo-check", "-"],
    "claude": ["claude", "-p"],
    "gemini": ["gemini", "-p"],
    "grok": ["grok", "run"],
    "opencode": ["opencode", "run"],
    "pi": ["pi", "-p"],
}


@dataclass(frozen=True)
class AgentResult:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False

    @property
    def combined_output(self) -> str:
        return "\n".join(part for part in (self.stdout, self.stderr) if part)


@dataclass(frozen=True)
class VerificationResult:
    passed: bool
    output: str
    commands: tuple[tuple[str, ...], ...] = ()


@dataclass(frozen=True)
class SupervisorResult:
    exit_code: int
    reason: str
    iterations: int


def parse_agent_command(value: str) -> list[str]:
    """Parse a JSON argv array, rejecting shell-like command strings."""
    try:
        command = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError("agent command must be a JSON array") from exc
    if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
        raise ValueError("agent command must be a non-empty JSON array of strings")
    return command


def _package_manager(repository: Path) -> str:
    if (repository / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (repository / "yarn.lock").exists():
        return "yarn"
    if (repository / "bun.lockb").exists() or (repository / "bun.lock").exists():
        return "bun"
    return "npm"


def discover_verification_commands(repository: Path) -> list[list[str]]:
    """Discover the strongest practical local checks from repository evidence."""
    package_json = repository / "package.json"
    if package_json.exists():
        data = json.loads(package_json.read_text(encoding="utf-8"))
        scripts = data.get("scripts", {})
        if isinstance(scripts, dict):
            manager = _package_manager(repository)
            if "check" in scripts:
                return [[manager, "run", "check"]]
            names = [name for name in ("test", "lint", "typecheck", "build") if name in scripts]
            if names:
                return [[manager, "run", name] for name in names]

    pyproject = repository / "pyproject.toml"
    if pyproject.exists():
        return [["python", "-m", "pytest"]]
    if (repository / "pytest.ini").exists() or (repository / "tests").is_dir():
        return [["python", "-m", "pytest"]]
    return []


def build_prompt(master_prompt: str, iteration: int, previous_evidence: str = "") -> str:
    if iteration == 1 and not previous_evidence:
        return master_prompt
    evidence = previous_evidence.strip() or "No additional verification evidence was captured."
    return f"""{master_prompt.rstrip()}

This is autonomous execution iteration {iteration}.

Previous agent invocations have already modified this repository.

Do not restart from scratch.

Before changing code:
- inspect git status
- inspect git diff
- inspect the repository progress file if one exists
- inspect relevant test results
- determine the highest-priority incomplete requirement
- continue from existing repository state

Repository state and tests are authoritative.

Do not stop merely to summarize progress.

Emit:
{ACS_MILESTONE_COMPLETE} only when all requested work is complete
{ACS_BLOCKED} only for a genuine external blocker
{ACS_CONTINUE} otherwise

Evidence from the previous invocation or independent verification:
---
{evidence}
---
"""


class Supervisor:
    def __init__(
        self,
        repository: Path,
        master_prompt: str,
        agent_command: Sequence[str],
        max_invocations: int = DEFAULT_MAX_INVOCATIONS,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        log_directory: Path | None = None,
        verification_commands: Sequence[Sequence[str]] | None = None,
        runner: Callable[..., AgentResult] | None = None,
    ) -> None:
        if max_invocations < 1:
            raise ValueError("max_invocations must be at least 1")
        self.repository = repository.resolve()
        self.master_prompt = master_prompt
        self.agent_command = list(agent_command)
        self.max_invocations = max_invocations
        self.timeout_seconds = timeout_seconds
        self.log_directory = (log_directory or self.repository / ".agent-runs").resolve()
        self.verification_commands = [list(command) for command in (verification_commands or discover_verification_commands(self.repository))]
        self.runner = runner or run_agent_process
        self._active_process: subprocess.Popen[str] | None = None
        self._interrupted = False
        self._current_iteration = 0

    def _handle_signal(self, signum: int, _frame: object) -> None:
        self._interrupted = True
        if self._active_process is not None:
            terminate_process(self._active_process)

    def _write_log(self, name: str, content: str) -> None:
        self.log_directory.mkdir(parents=True, exist_ok=True)
        (self.log_directory / name).write_text(content, encoding="utf-8")

    def _log_agent(self, iteration: int, prompt: str, result: AgentResult) -> None:
        self._write_log(
            f"run-{iteration:04d}.log",
            "COMMAND: " + shlex.join(result.command) + "\n\nPROMPT:\n" + prompt +
            "\n\nSTDOUT:\n" + result.stdout + "\n\nSTDERR:\n" + result.stderr +
            f"\n\nRETURNCODE: {result.returncode}\nTIMED_OUT: {result.timed_out}\n",
        )

    def invoke_agent(self, prompt: str, iteration: int) -> AgentResult:
        try:
            result = self.runner(
                self.agent_command,
                prompt,
                self.repository,
                self.timeout_seconds,
                self._set_active_process,
            )
        except OSError as exc:
            result = AgentResult(self.agent_command, 127, "", f"agent invocation failed: {exc}")
        self._log_agent(iteration, prompt, result)
        return result

    def _set_active_process(self, process: subprocess.Popen[str] | None) -> None:
        self._active_process = process

    def verify_repository(self) -> VerificationResult:
        if not self.verification_commands:
            output = "No repository-local verification command could be discovered."
            self._write_log(f"verification-{self._current_iteration:04d}.log", output)
            return VerificationResult(False, output)

        chunks: list[str] = []
        passed = True
        for command in self.verification_commands:
            try:
                completed = subprocess.run(command, cwd=self.repository, text=True, capture_output=True, check=False)
                returncode = completed.returncode
                command_output = completed.stdout + completed.stderr
            except OSError as exc:
                returncode = 127
                command_output = f"verification command failed to start: {exc}\n"
            chunks.append(f"$ {shlex.join(command)}\n{command_output}\nexit={returncode}")
            if returncode != 0:
                passed = False
                break
        output = "\n\n".join(chunks)
        self._write_log(f"verification-{self._current_iteration:04d}.log", output)
        return VerificationResult(passed, output, tuple(tuple(command) for command in self.verification_commands))

    def run(self) -> SupervisorResult:
        old_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)
        evidence = ""
        last_verification_failed = False
        try:
            for iteration in range(1, self.max_invocations + 1):
                if self._interrupted:
                    return SupervisorResult(130, "interrupted", iteration - 1)
                prompt = build_prompt(self.master_prompt, iteration, evidence)
                result = self.invoke_agent(prompt, iteration)
                output = result.combined_output
                if result.timed_out or result.returncode != 0:
                    evidence = f"Agent invocation failed (exit={result.returncode}, timed_out={result.timed_out}).\n{output}"
                if ACS_BLOCKED in output:
                    return SupervisorResult(2, "agent reported a genuine external blocker", iteration)
                if ACS_MILESTONE_COMPLETE in output:
                    self._current_iteration = iteration
                    verification = self.verify_repository()
                    if verification.passed:
                        return SupervisorResult(0, "milestone independently verified", iteration)
                    evidence = "Milestone marker was not accepted because independent verification failed:\n" + verification.output
                    last_verification_failed = True
                else:
                    last_verification_failed = False
                    if not evidence:
                        evidence = output or "Agent produced no output or terminal marker."
            if last_verification_failed:
                return SupervisorResult(4, "invocation limit reached after verification failed", self.max_invocations)
            return SupervisorResult(3, "maximum invocation count exhausted", self.max_invocations)
        finally:
            self._active_process = None
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)


def terminate_process(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    except ProcessLookupError:
        pass


def run_agent_process(
    command: Sequence[str],
    prompt: str,
    repository: Path,
    timeout_seconds: int,
    set_active_process: Callable[[subprocess.Popen[str] | None], None],
) -> AgentResult:
    process = subprocess.Popen(
        list(command),
        cwd=repository,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    set_active_process(process)
    timed_out = False
    try:
        stdout, stderr = process.communicate(prompt, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        terminate_process(process)
        stdout, stderr = process.communicate()
        prior_stdout = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        prior_stderr = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        stdout = prior_stdout + stdout
        stderr = prior_stderr + stderr
    finally:
        set_active_process(None)
    return AgentResult(list(command), process.returncode, stdout, stderr, timed_out)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt_file", type=Path)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--agent", choices=sorted(DEFAULT_AGENT_COMMANDS), default=os.getenv("AUTONOMOUS_AGENT", "codex"))
    parser.add_argument("--agent-command-json", help="JSON argv array overriding the selected agent command")
    parser.add_argument("--max-invocations", type=int, default=int(os.getenv("AUTONOMOUS_AGENT_MAX_INVOCATIONS", DEFAULT_MAX_INVOCATIONS)))
    parser.add_argument("--timeout", type=int, default=int(os.getenv("AUTONOMOUS_AGENT_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)))
    parser.add_argument("--logs-dir", type=Path, default=None)
    parser.add_argument("--verify-command-json", action="append", help="JSON argv array; repeat to override auto-discovery")
    args = parser.parse_args(argv)

    repository = args.repo.resolve()
    prompt_file = args.prompt_file if args.prompt_file.is_absolute() else repository / args.prompt_file
    if not prompt_file.is_file():
        parser.error(f"prompt file does not exist: {prompt_file}")
    if not repository.is_dir():
        parser.error(f"repository does not exist: {repository}")

    command_value = args.agent_command_json or os.getenv("AUTONOMOUS_AGENT_COMMAND_JSON")
    try:
        agent_command = parse_agent_command(command_value) if command_value else DEFAULT_AGENT_COMMANDS[args.agent]
        verification_commands = (
            [parse_agent_command(value) for value in args.verify_command_json]
            if args.verify_command_json
            else None
        )
    except ValueError as exc:
        parser.error(str(exc))

    result = Supervisor(
        repository=repository,
        master_prompt=prompt_file.read_text(encoding="utf-8"),
        agent_command=agent_command,
        max_invocations=args.max_invocations,
        timeout_seconds=args.timeout,
        log_directory=args.logs_dir,
        verification_commands=verification_commands,
    ).run()
    print(f"{result.reason}; iterations={result.iterations}", file=sys.stderr)
    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
