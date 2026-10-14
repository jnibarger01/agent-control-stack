# Local advisor integration

The stdio server is `apps/local-advisor-mcp`. Build it from this worktree (`tsc -b apps/local-advisor-mcp`) and point a client at `apps/local-advisor-mcp/dist/cli.js`.

Do not let an installer rewrite `~/.claude.json`, OpenClaw's global config, or the ACS gateway environment. Paste a snippet into the client that should see the advisor.

Environment:

| Variable | Meaning |
| --- | --- |
| `ACS_LOCAL_ADVISOR_MODEL` | Installed Ollama model. Skips the route table. |
| `ACS_LOCAL_ADVISOR_EXPECTED_DIGEST` | Optional `sha256:<64 hex>` pin. Mismatch refuses generation. |
| `ACS_LOCAL_ADVISOR_BASE_URL` | Loopback only. Default `http://127.0.0.1:11434`. |
| `ACS_LOCAL_ADVISOR_ROUTES` | JSON array of `{ role, model, operations, expectedDigest? }` used when `MODEL` is unset. |
| `ACS_LOCAL_ADVISOR_MIN_FREE_BYTES` | Refuse inference when `os.freemem()` is below this. |

The server does not download models. Install and measure them with Ollama yourself. `nvidia-smi` in model-broker does not see an AMD GPU; free system RAM is the only pressure check here.

## Tools

`advisor_review_plan`, `advisor_diagnose_failure`, `advisor_review_completion`.

Each takes `requestId`, `mission` (`id`, `envelopeHash`), `context` (`objective`, optional `constraints`, optional `evidence`), and `budget` (`timeoutMs`, `maxOutputTokens`). Evidence text is untrusted. The tool name sets the operation; a client cannot retarget it.

A successful MCP result can still have `status` other than `completed`. That is not a pass. `completed` is still not ACS authorization.

## Claude Code

Add this to the project `.mcp.json` you intend to use, not to a global file this process does not own:

```json
{
  "mcpServers": {
    "acs-local-advisor": {
      "command": "node",
      "args": ["apps/local-advisor-mcp/dist/cli.js"],
      "env": {
        "ACS_LOCAL_ADVISOR_MODEL": "qwen2.5-coder:7b"
      }
    }
  }
}
```

Paths are relative to the worktree. Protocol `2024-11-05` is what the server speaks. It also accepts initialize requests that offer `2025-03-26` or `2025-06-18` and answers with `2024-11-05`.

## OpenClaw

Same stdio command and env. Register the server as a local MCP process in the OpenClaw profile for this repo. Do not point it at a hosted inference URL. The process refuses non-loopback Ollama endpoints.

## ACS

Keep using the gateway for execution. When a mission requires an advisor result, call `decideAdvisorRequirement` from `@agent-control-stack/policy-gate` with the advisor `status`:

- `not_required` leaves the existing authorization decision alone (`not_applicable`).
- `required` plus `completed` is `evidence_only`. Policy still has to allow the action on its own evidence.
- `required` plus any other status is `fail_closed`.

`projectReviewFinding` stores a completed review as `acs.review-finding.v1` only when ACS already has an evidence-manifest hash and an attempt id, and only for the mission and request (`missionId`, `inputHash`) that were actually reviewed. `advisorTraceEvent` is the LoopTrace record. Neither function approves work.

## Benchmark

Live model quality is not assumed from the model name. Set `ACS_LOCAL_ADVISOR_OLLAMA_MODEL` and run:

```text
npx vitest run packages/local-advisor/src/ollama.integration.test.ts
```

That test is skipped unless the variable is set, and it never pulls a model. If Ollama or the model is absent, the run is unverified, not a pass.
