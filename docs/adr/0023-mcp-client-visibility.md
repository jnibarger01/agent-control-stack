# ADR 0023: MCP client visibility and labelling on the Commander edge lanes

## Status

Accepted.

## Context

ChatGPT, Muse, Grok and other clients reach ACS through the edge (`apps/dc-mcp-gateway`): `/jc/mcp` for Jace
Commander and `/mcp` for Desktop Commander. ACS only sees one `POST /{jc,dc}/capability/issue` per
`tools/call`. Operators could not tell which client was calling:

- The edge prefixed every subject with `chatgpt:`, so any client looked like ChatGPT.
- The audit event kept the actor and subject but not the OAuth `client_id`.
- Nothing recorded a client _connecting_ (`initialize`, `tools/list`), only successful or denied calls.
- Mission Control's Connectors page covers registered tunnel/OAuth connectors, not these lanes.

## Decision

Make callers visible and nameable, and add one optional fail-closed control. Nothing here grants authority.

1. **Trust levels are explicit.** The OAuth `client_id` and `sub` are verified by the edge. Everything the client
   says about itself (`initialize.clientInfo`, `User-Agent`) is an unverified claim, bounded to printable ASCII,
   stored separately and always shown as "says it is".
2. **Edge reports; ACS records.** The edge caches `clientInfo` per verified client, forwards it on issuance as
   `x-mcp-client-*` headers, and reports `initialize` and `tools/list` to `POST /mcp-clients/observe`
   (fire-and-forget, 1.5 s timeout, throttled; it can never delay, alter or fail a request). The route requires
   the lane's own bridge identity and rejects a report for the other lane.
3. **Audit.** `connector.requested` now carries `mcpClientId`, `mcpLane` and the claims. Connects are
   `mcp_client.seen`; operator labels are `mcp_client.labelled` and `mcp_client.label_cleared`. No migration.
4. **A bounded read model.** The gateway rebuilds an in-memory index from those events at startup and updates
   it from the live event stream. It tracks at most 500 clients (least recently seen unlabelled first to go) and
   dedupes connect events to one per 30 s per client, subject and method.
5. **Labels are human-only and attribution-only.** Only a human operator (`actor: user`, `operator` role,
   `acs:approve`) can label or clear. Only a client ACS has actually seen can be labelled, so a label cannot
   pre-authorize an invented id. A label never approves, issues or widens anything.
6. **Optional enforcement, off by default.** `ACS_MCP_CLIENT_POLICY=require_label` makes both issuance routes
   deny a client with no label (`403 mcp_client_unlabelled`). It can only deny; every existing policy, approval,
   lease and admission check still runs for labelled clients. It is an environment setting, not a UI toggle, so
   it cannot be flipped from the browser. Unknown values refuse to start.
7. **One identity per client, checked at the last moment.** A verified client id the audit redactor would alter
   (for example a URL containing an `sk-...` segment) is replaced by `sha256:<digest>` before it is indexed,
   labelled, audited or gated, and the edge digests ids over 256 characters instead of truncating them, so
   distinct ids never collapse and a label always matches what the gate sees. `require_label` is evaluated
   again after a call finishes waiting for execution admission, so clearing a label stops an already queued call.
   The observe, label and list routes are covered by the gateway rate limiter.
8. **Existing identities do not change.** The edge keeps the `chatgpt:<sub>` actor string: approvals, requester
   subjects and admission keys already depend on it. Distinguishing clients is done with `client_id`, not by
   renaming actors. (The prefix is historical and misleading; renaming it is a separate, breaking change.)

## Consequences

- Mission Control shows each client with its label or "Unrecognized", an unverified suggestion (ChatGPT, Muse,
  Grok, Claude, Gemini) derived from claims, lanes, counts, last tool and liveness, plus a global alert when an
  unrecognized client is active.
- Calls recorded before this change have no `client_id`; they appear under "Earlier callers" grouped by
  subject and cannot be labelled.
- Whether Muse and Grok are distinguishable depends on each registering its own OAuth client. If they share
  one `client_id` with ChatGPT they will look like one client; the claims and subject still show in the row.
- Turning on `require_label` blocks every unlabelled client immediately. Label the ones you trust first.

## Rejected alternatives

- **Trust `clientInfo` or User-Agent to identify clients.** Self-declared and trivially spoofed.
- **Rename the actor prefix per client.** Breaks existing approvals and requester bindings.
- **Allow-by-label as a grant.** A label would become authority. Labels only ever deny-by-absence.
- **A UI switch for `require_label`.** A browser session should not be able to change the authorization
  posture of an execution lane.
- **A new table.** Migration numbering is contended; the audit log already holds the facts.
