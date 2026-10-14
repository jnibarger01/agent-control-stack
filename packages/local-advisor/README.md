# @agent-control-stack/local-advisor

Local Ollama reviewer for Claude Code, OpenClaw, ACS, and any other MCP client.

Outputs are untrusted recommendations. This package does not grant capabilities, approve execution, run a shell, write repository files, or override `packages/policy-gate`.

## Why this is not `jev-advisor`

`@agent-control-stack/jev-advisor` is the System One / Noul probability client (ADR 0020). Its ESLint allow-list is limited to the shadow hook and the observation worker. An Ollama chat reviewer is a different protocol. Putting it in that package would let a free-form model through the probability-adapter allow-list. This package reuses advisory verdicts (`PASS | NEEDS_CHANGES | BLOCK | UNKNOWN`), `assertLoopback` from model-broker, and LoopTrace's evidence event schema.

## Contract

`advisor.v1`. Operations: `review_plan`, `diagnose_failure`, `review_completion`.

A response carries `status`. Only `completed` includes a verdict. `unavailable`, `timeout`, `invalid_output`, and `insufficient_evidence` never include a verdict.

Use `recordLocalAdvisorConsultation` to write the same `acs.advisor-consultation.v1` row as the gateway (caller-supplied fence; no invented lease). `projectReviewFinding` / `projectReviewFindingFromConsultation` and the `advisor.recorded` helpers are derived views at trust `asserted` only.

Completed reviews can be projected to `acs.review-finding.v1` with `projectReviewFinding`. The caller must supply the ACS evidence-manifest hash plus the reviewed `missionId` and `inputHash`, and `workItemId` must equal that `missionId` (the trace's `work_item_id`); any mismatch throws `ReviewBindingError`. The advisor does not invent a manifest hash.

`decideAdvisorRequirement` in `@agent-control-stack/policy-gate` is the governance hook:

- advisor not required: `not_applicable` (authorized ACS work continues)
- required and completed: `evidence_only` (still not an allow)
- required and not completed: `fail_closed`

## Ollama

Default endpoint `http://127.0.0.1:11434`. Non-loopback URLs and redirects are refused. The provider reads `/api/tags` before every generation and records `sha256:<digest>`. It never calls `/api/pull`.

`DEFAULT_MODEL_ROUTES` prefers `qwen3-coder:30b` for plan and completion review, `nimble` for diagnosis, and `qwen2.5-coder:7b` as fallback. A route is used only when that model is already installed and, when Ollama reports capabilities, those include completion. A name:latest tag also matches the unsuffixed route name. Embedding-only and decision-only tags are not selected. One model is selected per request.

## LoopTrace

`advisorTraceEvent` emits `advisor.recorded` on the existing `looptrace-evidence/1` schema. Trust is `asserted`, stage is `lifecycle`, so the event cannot produce a LoopTrace PASS. Prompts are not stored. Finding text is redacted and clipped.

## MCP

`apps/local-advisor-mcp` (`acs-local-advisor-mcp`) speaks MCP over stdio. See [docs/local-advisor/INTEGRATION.md](../../docs/local-advisor/INTEGRATION.md). The server does not edit client configuration and does not open a port.
