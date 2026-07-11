<!-- ijfw-schema: v1 -->
# Knowledge Base
---
type: decision
summary: Direct agent MCP runs require approval scope
stored: 2026-07-09T04:26:48.714Z
hash: baf3427652a1
tags: [security, mcp, direct-agent, authorization]
---
<!-- hash:baf3427652a1 -->
Security decision: MCP `test.agent.run` must be treated as approval-scoped/mutating, not read-only, because several supported direct agent CLIs do not have enforced read-only sandboxing. Gateway tool metadata should require `acs:work:approve`, set `readOnlyHint: false`, and require a registered actor; machine-controller audit should not classify direct agent runs as `read_only`.

**Why:** Read-scoped callers could otherwise spawn local agent CLIs as the gateway user, and not every supported CLI enforces read-only execution.

**How to apply:** When adding or changing direct agent execution surfaces, require approval-scoped authorization or prove and test enforced read-only sandboxing for every supported agent.
