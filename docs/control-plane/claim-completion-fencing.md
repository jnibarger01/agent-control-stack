# Claim and completion fencing

A call is targeted at one durable tuple captured at dispatch:

- authenticated user ID;
- device ID;
- active Supabase Auth session ID bound to that device; and
- live Presence connection generation.

`claim_mcp_remote_call` and `complete_mcp_remote_call` accept the target device ID and lock the row only when call ID, authenticated user, and target device all match. They additionally require the target session, claimed session, target generation, claimed generation, and current active device-session binding to match. A same-user session bound to another device cannot claim or complete the call.

The deadline is a durable terminal fence. Claim and completion lock the call row before evaluating the deadline. If a pending or executing row is past its deadline, the same transaction changes it to `timed_out`; a late completion receives no row and cannot replace the timeout result. `expire_mcp_remote_call` applies the same conditional terminal transition for read-time expiry.

These source-level guarantees do not replace the required private non-production PostgREST/Supabase ACL, RLS, JWKS, replay, and key-rotation negative tests. Device onboarding remains deliberately unavailable: `/device/start` and `/device/poll` return 503 until an approved identity-provider integration exists.
