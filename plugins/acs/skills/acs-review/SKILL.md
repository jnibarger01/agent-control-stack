---
description: Review Agent Control Stack changes for policy, approval, audit, MCP, and local execution safety issues.
---

Review the selected changes or current repository state for Agent Control Stack.

Focus on:

1. Approval bypass risks
2. Policy evaluation gaps
3. Audit log integrity
4. MCP server exposure
5. OAuth/authentication mistakes
6. Unsafe command execution
7. Secret leakage
8. Worker execution boundary failures
9. Replay or idempotency bugs
10. Tests needed before release

Return:

- Verdict: PASS, PASS_WITH_CONCERNS, or BLOCK
- Highest-risk finding first
- Concrete file-level fixes
- Tests that should be added
