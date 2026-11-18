# AI Factory proposal contract v1

**Implemented in F0:** `packages/ai-factory` is a pure parser/proposer. This schema defines untrusted intent, not dispatch authority. The wire example is illustrative; executable tests are in `packages/ai-factory/src/plan.test.ts`.

## Input

```json
{
  "schemaVersion": "acs.ai-factory.intent.v1",
  "orderId": "order_001",
  "objective": "Add a scoped health endpoint with tests",
  "repository": "jnibarger01/agent-control-stack",
  "baseSha": "0000000000000000000000000000000000000000",
  "acceptanceCriteria": [
    "A scoped endpoint returns 200 under a healthy fixture",
    "Negative authorization fixture is refused"
  ],
  "permittedPaths": ["apps/gateway/src", "apps/gateway/test"],
  "forbiddenPaths": [".github/workflows", "apps/gateway/src/secrets"],
  "budget": {
    "maxLanes": 2,
    "maxWallClockMs": 1200000,
    "maxSpendMicrousd": 2000000
  },
  "delivery": { "mode": "draft_pr" }
}
```

The example `baseSha` is a placeholder. F1 admission must verify it exists, matches the intended repository, and is permitted by ACS policy before dispatch.

### Input invariants

- Exact top-level and nested fields, **no unknown keys**. Caller-supplied `actor`, `approvalId`, `leaseId`, `capability`, `allowPush`, `autoMerge` and `approved` are rejected, not ignored.
- `orderId` follows existing identifier character constraints; `objective` and criteria are bounded nonempty strings (no secrets); repository is an explicit owner/name, not a URL or arbitrary remote.
- `baseSha` is 40 lowercase hex; resolution and ancestry are deferred to an authoritative repository reader, not guessed from format.
- Paths are normalized relative POSIX roots with no empty, dot, dot-dot, backslash, NUL, colon, absolute path or `.git` segment; globs are not part of this intake version. This is **syntax validation only**, not realpath or filesystem containment.
- `permittedPaths` must be nonempty. The forbidden list is evaluated **after** permission and wins on overlap in F3/F6.
- Budget is an explicit finite request, not a permission. ACS can reduce it but must never widen it without a fresh authorized order.
- Delivery mode is fixed to `draft_pr`. No field can express merge, push to root, deploy or production release.

## Output

`FactoryProposal` has:
- `schemaVersion: "acs.ai-factory.proposal.v1"`,
- `intentHash`: SHA-256 of a canonicalized, strictly parsed intent,
- the normalized immutable `intent` snapshot,
- `executionMode: "proposal_only"` and `authority: "none"`,
- `delivery: "draft_pr"` and `requestedEngine: "codex-swarm"`.

The digest supplies **equality and idempotency input, not authentication**. A malicious client can compute its own digest. ACS must bind it to the authenticated caller, admitted mission and policy; nothing in the proposal can be treated as an approval or an execution permit.

## Future F2 binding (not implemented in F0)

```text
ACS authenticated caller
  + proposal intent hash
  + canonical GitHub repo ID and immutable base SHA
  + current policy version
  + ACS mission ID and unit IDs
  + admission / budget decision
  -> ACS-persisted admission receipt and authoritative attempt envelope
```

Idempotency: (`principal`, `orderId`) maps to exactly one intent hash; replay with the same hash retrieves the recorded admission, replay with a different hash conflicts. This must be atomic inside the ACS mission store.

## Upgrade policy

Unknown schema version fails. New optional fields require a v2 or explicitly tested additive schema evolution; older readers must not silently discard authority-looking fields. Canonicalization changes require fixtures and a compatibility test, not a silent hash change.

## Do not use proposal output as a credential

No F0 API, DB, queue, scheduler, network endpoint, engine invocation, or publisher is installed. The API is internal-only; the package exposes deterministic functions to be bound into ACS by later PRs.

