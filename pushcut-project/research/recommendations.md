# Recommendations

## First project decision

Keep **Infrastructure Command Center** as the first project, but implement it as a presentation/orchestration layer over server-side diagnostics and ACS. Do not begin with direct repair-over-SSH from an iPhone or with Automation Server as a required dependency.

This creates the strongest reusable foundation: one bounded payload contract, one mobile menu, one diagnostic endpoint, one ACS approval boundary, and multiple result channels.

## Recommended phased architecture

### Phase A: display-only, no credentials

Build the Shortcut from `shortcuts/infrastructure-command-center.md` with mock dictionaries. It validates and displays data without network calls.

Acceptance: malformed input is rejected, exact mock payloads render, and no action leaves the device.

### Phase B: read-only diagnostics

Expose one narrow HTTPS endpoint behind Tailscale or another authenticated private channel. It accepts only enumerated targets/actions and creates read-only ACS work. The Shortcut receives a request ID and renders a bounded diagnostic result.

Acceptance: no arbitrary command/text reaches a shell; timeout and duplicate behavior are deterministic; every request/result is audited; no repair code path exists.

### Phase C: Pushcut notification delivery

Store a revocable Pushcut API key only on the server. Send alerts through a deduplicating adapter. A notification action opens the Command Center or an authenticated approval surface.

Acceptance: harmless test explicitly approved; key absent from payload/log/Git; notification ID and request ID correlated; delivery is not recorded as execution success.

### Phase D: ACS repair approvals

Add an authenticated mobile approval endpoint to ACS. Preserve ACS’s actual model: approval record plus action hash/work item/principal/expiry/revocation/one-time consumption, not a bearer “approval token.” The phone can approve or reject only the exact pending proposal.

Acceptance: mismatched, expired, replayed, spoofed, or revoked decisions fail closed; policy is rechecked at claim; lease fencing and audit remain intact; ambiguous execution is reconciled, never retried.

### Phase E: optional Automation Server

Use a dedicated iOS device only for bounded read-only Shortcuts that genuinely require iOS-local data/actions. Monitor its status separately and retain a server-side fallback.

Acceptance: action allowlist enabled in Pushcut; execution under 10 seconds unless Extended is deliberately purchased; stuck request and offline tests pass; no repair depends on this path.

## Mobile authentication decision still required

Tailscale connectivity and a Pushcut device name are not sufficient identity. Before live approval, choose and implement an ACS-compatible authenticated principal mechanism that a Shortcut can use without embedding a durable high-value bearer credential. Candidate designs need a separate threat model; this project intentionally does not invent or enable one.

## Operating defaults

- Read-only by default.
- Server-side Pushcut API key in a protected environment variable.
- Stable reference IDs where possible; names remain human-readable configuration.
- Capped payload sizes and evidence lists.
- Five-minute maximum proposal lifetime unless policy requires shorter.
- No automatic repair retry after any ambiguous result.
- One idempotency record per action hash and work item.
- Redacted lock-screen text; exact action shown only after authenticated access.
- Telegram receives redacted results, never secrets or approval capability.
