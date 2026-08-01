# Build “Approve Repair” Manually

## Security role

This Shortcut records a human decision through an authenticated ACS endpoint. It never runs the proposed command. A Pushcut tap, Shortcut invocation, device name, or Tailscale address is not sufficient authorization.

## Construction

1. Create **Approve Repair** and accept a dictionary from other Shortcuts.
2. Use **Get Dictionary from Input** and require:
   - `schema_version` = `1.0`
   - `work_item_id`
   - `action_hash` matching `sha256:` plus 64 lowercase hexadecimal characters
   - `target_machine` in `jacen-ubuntu`, `hp-server`
   - structured `exact_action.kind`, `program`, and `arguments`
   - `expected_effect`, `risk`, `rollback_method`
   - parseable `approval_expires_at`
3. Fetch the authoritative proposal from ACS by `work_item_id`; do not trust the notification copy.
4. Compare the fetched action hash and all displayed proposal fields to the input. On mismatch, show “Proposal changed or mismatched” and stop.
5. Compare current date to expiration. On expiry, show “Approval expired” and stop.
6. Build a review **Text** block:

   ```text
   Target machine: …
   Exact command or API action: program + individually quoted arguments
   Expected effect: …
   Risk: …
   Rollback: …
   Approval expires: …
   Work item / action hash: …
   ```

7. Show the review with **Quick Look** or **Show Result**.
8. Add **Choose from Menu**: **Approve once**, **Reject**, **Cancel**.
9. For Approve/Reject, build a decision dictionary containing only schema version, work item ID, action hash, and decision. The authenticated endpoint derives the principal; the Shortcut must not supply/trust a caller identity field.
10. POST to a fixed `<ACS_BASE_URL>/...` decision endpoint using the separately approved mobile authentication mechanism. The exact route is intentionally not invented here; current ACS protocol must be extended/reviewed first.
11. Parse the ACS response and show its audit/work-item correlation. Never interpret network timeout as approval success; query the work item.
12. **Cancel** stops without a network call.

## Required server checks

ACS must verify authentication, principal, work item, action hash, scope, expiry, revocation, prior use, policy, and transactional consumption. The worker must recheck policy and current lease before executing. Duplicate decisions return the existing state and must not execute again.

## Tests

- malformed proposal: stop locally;
- mismatched fetched hash: reject;
- expired: no decision call;
- rejected: no execution;
- duplicate approved callback: one authoritative approval/use only;
- timeout: display unknown and query; do not repeat decision blindly;
- approved harmless demonstration action: only after explicit user approval and observed ACS audit evidence.
