import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.autonomous_agent import (
    ACS_BLOCKED,
    ACS_MILESTONE_COMPLETE,
    AgentResult,
    Supervisor,
    VerificationResult,
    build_prompt,
    discover_verification_commands,
    parse_agent_command,
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


if __name__ == "__main__":
    unittest.main()
