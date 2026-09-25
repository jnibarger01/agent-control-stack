# ACS Strands runtime

Strands is the agent runtime. ACS is the authority/control plane. Desktop Commander
is the executor. This package uses `@strands-agents/sdk` 1.19.0 directly: the SDK
owns the agent loop, streaming, context window and interrupts. It does not import
the assembled coding harness or any vended host tools.

```text
CLI / application -> Strands -> model provider
                        |
                 constrained ACS tools
                        |
     ACS: POST /harness/dc-invocations        (policy, approval, audit)
          POST /harness/dc-invocations/:id/dispatch
                        |
     managed DC gateway (single executor-lease holder) polls POST /dc/harness/next,
     replays the call through its own governed /mcp path:
          ACS /dc/capability/issue bound to that work item -> bridge -> DC
                        |
          accepted result + capability audit
                        |
     GET /work-items/:id/execution-result -> Strands -> model
```

## Run

From the ACS repository root, with Node 24.16+ and the repository's npm version:

```bash
npm ci
export HARNESS_MODEL=ollama/qwen3.5:9b
export HARNESS_ACS_URL=http://127.0.0.1:3000
# Supply HARNESS_ACS_TOKEN through your existing credential mechanism.
npm run harness -- "List /home/jacen/projects and tell me whether agent-control-stack exists."
```

The ACS gateway must run this branch, and the managed DC gateway
(`desktop-commander-mcp-gateway`) must run with `ACS_HARNESS_DISPATCH=1`
(its `feat/harness-dispatch` change). No second executor is started: the
existing lease holder executes harness calls exactly like connector calls.
The harness credential needs the ACS operator/service role with `acs:write`
(to request and dispatch) and `acs:read`; it can never approve its own work.

| Variable                   | Meaning                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `HARNESS_MODEL`            | `openai/<id>`, `anthropic/<id>`, `gemini/<id>`, `google/<id>`, or `ollama/<id>`                           |
| `HARNESS_ACS_URL`          | ACS HTTP origin; HTTPS required except on loopback                                                        |
| `HARNESS_ACS_TOKEN`        | Existing ACS authenticated create/read credential; never given to the model                               |
| `OPENAI_API_KEY`           | OpenAI provider credential                                                                                |
| `ANTHROPIC_API_KEY`        | Anthropic provider credential                                                                             |
| `GEMINI_API_KEY`           | Google provider credential                                                                                |
| `HARNESS_OPENAI_BASE_URL`  | Optional trusted OpenAI-compatible inference endpoint                                                     |
| `HARNESS_OLLAMA_BASE_URL`  | Ollama OpenAI-compatible API; defaults to `http://127.0.0.1:11434/v1`                                     |
| `OLLAMA_API_KEY`           | Optional authenticated Ollama deployment credential                                                       |
| `HARNESS_REASONING_EFFORT` | Optional `none`/`minimal`/`low`/`medium`/`high` for OpenAI/Ollama; use `none` for 4K-context local models |

Provider selection changes only model construction. Ollama uses Strands'
OpenAI-compatible provider. No ACS/DC code changes are needed to switch providers.
Cloud providers have construction/contract tests; live credentials are not assumed.

## Tools, approval and sessions

The model sees only `list_directory`, `read_file`, and `write_file`. Each call
becomes one ACS invocation; none reads or writes the runtime's filesystem. ACS
derives the requester subject (`strands:<hash>` of credential + session +
tool-use), runs policy, records approval, and later claims, issues the
capability and records completion. This package cannot approve, claim, sign a
capability, execute a process, or reach DC. Subagents, background tools, memory
stores and plugins are disabled. Sliding-window context management is enabled.

Correlation: every call carries `strands:<session UUID>:<invocation id>` on its
work item, through the capability, lease, result and audit events, so
`GET /work-items/:id` answers which model call caused which device operation,
which policy decision and capability authorized it, and how it ended.

Create is idempotent per invocation id, so an ambiguous create is retried with
the same id and ACS returns the existing item instead of a second action. Raw
tool arguments are never persisted in ACS: dispatch re-sends them and ACS
re-verifies the stored invocation binding before queueing (in memory only).

Approval: when ACS reports `needs_approval` (strict mode), dispatch is refused
with `require_approval` and Strands pauses with that code and the work-item ID.
Approve it through the ACS operator UI/API, then enter `resume`. A resume
message confers no authority; the runtime re-reads ACS. In admin mode ACS
auto-authorizes at issuance under its executor-lease gate.

Execution: after dispatch the runtime reads ACS status every 500 ms for at most
60 s, re-dispatching (idempotently) only if an approved item has not been
claimed within 15 s. It then pauses with `awaiting_execution` rather than
looping. ACS claims an approved item exactly once, so a re-dispatch, gateway
restart or replayed issuance cannot execute it twice.

The CLI streams model text, limits each invocation to 24 turns and five minutes,
and returns exit code 2 when paused/incomplete. Interactive resume works within
the same process. Cross-process resume is not implemented: **do not rerun a
mutation prompt to retry an uncertain operation**; inspect the ACS work item.

## Result and audit boundary

`GET /work-items/:id/execution-result` uses the gateway's read authorization.
It checks the stored result hash, work-item/action/lease/worker binding, real DC
execution metadata, and bound audit evidence from either executor route (worker:
authorization_granted + completed; managed bridge: policy-bound lease issuance +
accepted result), plus the capability issuance. Output is redacted.

Threat boundary: the ACS credential and provider URLs are trusted operator
configuration. This is a tool-authority boundary, not OS sandboxing. The bridge
hand-off grants nothing ACS has not approved: a `strands:` subject can only
obtain a capability for the exact dispatched item it is bound to, and no other
caller can target an item by id.

## Verify

```bash
npm run harness -- --help
npm run typecheck
npx tsc -b && npx vitest run packages/strands-runtime/src apps/gateway/src/harness-result.test.ts apps/gateway/src/harness-dispatch.test.ts apps/gateway/src/dc-capability-issue.test.ts
npx vitest run packages/desktop-commander-adapter/src packages/work-items/src/result-submission.test.ts apps/worker/src/index.test.ts
npm run contracts:check
npm run check
```

`acs-gateway.integration.test.ts` drives the real Strands loop against the real
ACS gateway routes (policy, approval, dispatch, issuance, result, audit) with only
the DC process simulated; it imports the gateway build, so run `npx tsc -b` first.
The bridge poller has its own tests in `desktop-commander-mcp-gateway`
(`node --test test/harness-dispatch.test.mjs`). A live device smoke has not run
from this branch yet.

SDK reference: https://strandsagents.com/docs/user-guide/sdk/quickstart/typescript/
Interrupt reference: https://strandsagents.com/docs/user-guide/sdk/interrupts/
