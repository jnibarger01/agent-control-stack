# ADR 0004: Request-bound one-time approval tokens

## Status

Accepted

## Context

Risky actions need human approval, but approval must not become a reusable permission slip. If approval says "write this file" and execution performs "run this shell script," the system has built a tiny betrayal machine.

## Decision

Approvals are bound to a canonical request hash and are valid for one execution only.

The request hash must include at minimum:

- Tool name
- Canonical arguments
- Normalized cwd
- Actor/requester identity
- Risk classification
- Policy version
- Created timestamp or nonce

Approval tokens must be:

- Random and high entropy
- Stored hashed at rest
- One-time use
- Expiring
- Bound to the exact request hash
- Invalidated when arguments change

## Approval lifecycle

```text
requested -> pending -> approved -> consumed
                  \-> denied
                  \-> expired
```

Execution must check:

1. Token exists.
2. Token hash matches stored approval.
3. Approval is `approved`.
4. Approval has not expired.
5. Approval has not been consumed.
6. Request hash matches current request.
7. Policy still permits execution.

## Consequences

- A token cannot authorize modified arguments.
- A token cannot be replayed.
- A stale approval cannot execute after policy changes if the current policy denies it.
- Approval storage becomes part of the trusted local security boundary.

## Rejected alternatives

### Approve by request ID only

Rejected. IDs are easy to confuse or replay unless bound to exact request content.

### Store raw tokens

Rejected. Token leakage from disk would directly grant authority.

### Long-lived approval grants

Rejected for MVP. They are useful later, but too risky before the single-action path is boringly correct.

## Implementation requirements

- Canonical JSON serialization must be deterministic.
- Request hash generation must be covered by tests.
- Changed argument order or semantically equivalent values should either canonicalize or intentionally produce a new request.
- Consuming an approval must be atomic with execution dispatch as far as practical.
