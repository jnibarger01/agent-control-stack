import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.autonomous_agent import (
    ACS_BLOCKED,
    ACS_CONTINUE,
    ACS_MILESTONE_COMPLETE,
    AgentResult,
    Supervisor,
    VerificationResult,
    build_prompt,
    discover_verification_commands,
    extract_protocol_marker,
    parse_agent_command,
    redact_text,
)


class AutonomousAgentTests(unittest.TestCase):
    def test_continuation_prompt_preserves_master_prompt_and_iteration_guidance(self):
        prompt = build_prompt("Implement the milestone.", 2, "npm test failed")

        self.assertIn("Implement the milestone.", prompt)
        self.assertIn("This is autonomous execution iteration 2.", prompt)
        self.assertIn("Do not restart from scratch.", prompt)
        self.assertIn("npm test failed", prompt)
        self.assertIn("<ACS_MILESTONE_COMPLETE>", prompt)

    def test_agent_command_is_an_argument_array_from_json(self):
        self.assertEqual(
            parse_agent_command('["codex", "exec", "--full-auto", "-"]'),
            ["codex", "exec", "--full-auto", "-"],
        )

    def test_verification_discovers_repository_check_script(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text(
                json.dumps({"scripts": {"check": "npm run lint && npm test"}}),
                encoding="utf-8",
            )
            (root / "package-lock.json").write_text("{}", encoding="utf-8")

            self.assertEqual(discover_verification_commands(root), [["npm", "run", "check"]])

    def test_complete_marker_requires_independent_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            supervisor = Supervisor(
                repository=root,
                master_prompt="finish it",
                agent_command=["fake-agent"],
                max_invocations=1,
                timeout_seconds=5,
                log_directory=root / ".agent-runs",
                verification_commands=[["false"]],
            )
            outputs = iter(
                [AgentResult(["fake-agent"], 0, ACS_MILESTONE_COMPLETE, "", False)]
            )
            with patch.object(supervisor, "invoke_agent", side_effect=lambda prompt, iteration: next(outputs)):
                with patch.object(
                    supervisor,
                    "verify_repository",
                    return_value=VerificationResult(False, "verification failed"),
                ) as verify:
                    result = supervisor.run()

            verify.assert_called_once()
            self.assertNotEqual(result.exit_code, 0)
            self.assertIn("verification failed", result.reason)

    def test_blocked_stops_without_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            supervisor = Supervisor(
                repository=root,
                master_prompt="finish it",
                agent_command=["fake-agent"],
                max_invocations=3,
                timeout_seconds=5,
                log_directory=root / ".agent-runs",
                verification_commands=[["true"]],
            )
            blocked = AgentResult(["fake-agent"], 0, ACS_BLOCKED, "external dependency unavailable", False)
            with patch.object(supervisor, "invoke_agent", return_value=blocked) as invoke:
                with patch.object(supervisor, "verify_repository") as verify:
                    result = supervisor.run()

            invoke.assert_called_once()
            verify.assert_not_called()
            self.assertEqual(result.exit_code, 2)

    def test_marker_quoted_in_prose_does_not_trigger_blocked_or_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            supervisor = Supervisor(
                repository=root,
                master_prompt="finish it",
                agent_command=["fake-agent"],
                max_invocations=1,
                timeout_seconds=5,
                log_directory=root / ".agent-runs",
                verification_commands=[["true"]],
            )
            # The agent merely quotes the marker in prose rather than
            # emitting it as a standalone protocol line.
            quoted = AgentResult(
                ["fake-agent"], 0, "I will not emit <ACS_BLOCKED> until the task is truly blocked.", "", False
            )
            with patch.object(supervisor, "invoke_agent", return_value=quoted):
                with patch.object(supervisor, "verify_repository") as verify:
                    result = supervisor.run()

            verify.assert_not_called()
            self.assertNotEqual(result.exit_code, 2)

    def test_marker_on_its_own_line_is_still_recognized_even_with_surrounding_prose(self):
        text = "Some reasoning here.\n<ACS_MILESTONE_COMPLETE>\nMore trailing notes."
        self.assertEqual(extract_protocol_marker(text), ACS_MILESTONE_COMPLETE)

    def test_marker_embedded_mid_line_is_not_recognized(self):
        text = "output was <ACS_MILESTONE_COMPLETE> according to the agent"
        self.assertIsNone(extract_protocol_marker(text))

    def test_blocked_marker_takes_priority_when_multiple_markers_appear_as_standalone_lines(self):
        text = f"{ACS_CONTINUE}\n{ACS_BLOCKED}"
        self.assertEqual(extract_protocol_marker(text), ACS_BLOCKED)

    def test_redact_text_removes_known_secret_shapes(self):
        secret_bearer = "Bearer sk-testFAKEsecretvalue1234567890abcdefgh"
        secret_ghp = "ghp_FAKEtestGithubPersonalAccessToken1234567890"
        redacted = redact_text(f"log line one\n{secret_bearer}\nlog line two\n{secret_ghp}")
        self.assertNotIn(secret_bearer, redacted)
        self.assertNotIn(secret_ghp, redacted)
        self.assertIn("[redacted]", redacted)
        self.assertIn("log line one", redacted)

    def test_agent_run_logs_are_redacted_and_owner_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log_directory = root / ".agent-runs"
            supervisor = Supervisor(
                repository=root,
                master_prompt="finish it",
                agent_command=["fake-agent"],
                max_invocations=1,
                timeout_seconds=5,
                log_directory=log_directory,
                verification_commands=[["true"]],
            )
            secret = "ghp_FAKEtestGithubPersonalAccessToken1234567890"
            leaking = AgentResult(["fake-agent"], 0, f"stdout with a credential: {secret}", "", False)
            with patch.object(supervisor, "invoke_agent", side_effect=lambda prompt, iteration: leaking):
                supervisor._log_agent(1, "prompt text", leaking)

            log_path = log_directory / "run-0001.log"
            content = log_path.read_text(encoding="utf-8")
            self.assertNotIn(secret, content)
            self.assertIn("[redacted]", content)

            if sys.platform != "win32":
                mode = stat.S_IMODE(log_path.stat().st_mode)
                self.assertEqual(mode, 0o600)


if __name__ == "__main__":
    unittest.main()
