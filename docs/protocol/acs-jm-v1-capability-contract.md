# acs.jm.v1 — Jace-Mem capability contract

Status: **issuer core implemented (slice JM-ACS-01)** in `packages/jace-mem-issuer`. There is no
`/jm/capability/issue` route, runtime bootstrap or lease-liveness check yet (JM-ACS-02/03), so Jace-Mem's
`acs-governed` mode stays blocked until those land and pass integration certification (JM-ACS-04).

ACS decides; Jace-Mem enforces. Jace-Mem never makes authorization decisions of its own: it verifies the signed
capability for the exact call and refuses everything else. Existing `acs.dc.v1` and `acs.jc.v1` issuance is
unchanged; this contract has its own package, table, signing key, audience and policy action kinds.

## Envelope

Identical to `acs.dc.v1` / `acs.jc.v1`: `{payload, signature, keyId}` at MCP `tools/call`
`params._meta.acsCapability`; raw Ed25519 over `UTF-8(strictCanonicalJsonV1(payload))`, unpadded base64url;
lifetime at most 30 s (issuer default 29 s); verifier skew 5 s; single-use nonce (32 random bytes).

## Payload (exact keys)

`version` `acs.jm.v1` · `issuer` `acs` · `audience` `jace-mem` · `runtimeId` · `workItemId` · `attemptId` ·
`leaseId` · `leaseEpoch` · **`subject`** · `toolName` · `normalizedArguments` · `invocationHash` · `actionHash` ·
`requestHash` · `planHash` · `scopes` · `approvalId` (present iff the tool requires approval) · `issuedAt` ·
`expiresAt` · `nonce`.

`subject` is exactly `{principal, agent, project, worktree, invocation}` under Jace-Mem's identity rules (non-empty,
trimmed, no control or format characters, 256 bytes; worktree 4096). Jace-Mem accepts a capability only when
`subject` equals its launch identity.

`invocationHash = sha256("acs:jace-mem-invocation:v1\n" + strictCanonicalJsonV1({toolName, arguments}))`.

## Tool manifest

| Tool                                                     | Scope           | Policy action kind | Approval |
| -------------------------------------------------------- | --------------- | ------------------ | -------- |
| `session_start`, `session_end`, `memory_capture`         | `memory.write`  | `jm.memory.write`  | no       |
| `memory_search`, `memory_get`, `memory_status`           | `memory.read`   | `jm.memory.read`   | no       |
| `memory_delete`, `session_delete`, `memory_retain_since` | `memory.delete` | `jm.memory.delete` | human    |
| `memory_search_shared`                                   | `memory.share`  | `jm.memory.share`  | human    |

Argument schemas are strict (exact keys, no coercion, no defaults) and use Jace-Mem's own size limits
(`packages/jace-mem-issuer/src/manifest.ts`).

## Issuance rules

1. **Subject binding.** The work item's single action carries the subject and its hash
   (`jaceMemActionParams`), so the subject is part of the action hash. `subject.agent` must equal the work item's
   attested `requesterSubject`; ACS never signs a subject for an agent other than the one it attested.
   `memory_search_shared` must target a different agent.
2. **Lease binding.** `authorizeJaceMemExecution` re-derives the running work item, the active unexpired lease held
   by the issuing worker at the claimed fencing epoch, the unchanged action hash and the exact invocation.
3. **Approvals.** Delete and share tools require a consumed approval bound to the plan and action hash, granted by a
   human who is neither the requester nor `acs:admin`. Policy (`packages/policy-gate/src/rules.ts`) denies
   self-approval and admin-mode approval for `jm.memory.delete` / `jm.memory.share`; the registry checks it again;
   the table's `CHECK` constraints check it a third time. Read and write tools must not carry an approval.
4. **Persistence before signing.** `SqliteJaceMemIssuanceRegistry.recordIssuance` commits a row in
   `jace_mem_capability_issuances` (migration 077) inside `BEGIN IMMEDIATE` before the payload is signed: one
   capability per lease + invocation and per approval, unique nonce hashes, append-only, subject stored only as a
   hash.
5. **Signing key.** `ACS_JACE_MEM_CAPABILITY_PRIVATE_KEY` (base64url PKCS#8 Ed25519), `ACS_JACE_MEM_CAPABILITY_KEY_ID`
   and `ACS_JACE_MEM_RUNTIME_ID` are all-or-nothing; absent config disables issuance. The key must differ from the
   `acs.dc.v1` and `acs.jc.v1` keys. `jaceMemVerificationKey` derives the SPKI value Jace-Mem needs as
   `JACE_MEM_ACS_PUBLIC_KEY`.

## Contract vectors

`packages/jace-mem-issuer/vectors/acs-jm-v1-contract-vectors.json` holds one capability per tool minted by the real
issuer path and 23 negative cases (impersonation, wrong worktree, re-signed subject, version/audience/issuer/runtime
substitution, tool and argument substitution, scope widening, approval bypass, extra keys, lifetime, expiry,
not-yet-valid, tampering, unknown key, malformed envelope and nonce), each naming the Jace-Mem rejection code.
Jace-Mem runs the same file through its verifier (`jace-mem test/acs-vectors.test.ts`), including replay and replay
after restart. Regenerate with `UPDATE_JM_VECTORS=1 npx vitest run packages/jace-mem-issuer/src/contract-vectors.test.ts`
and copy the file to Jace-Mem.

## Not yet implemented

- **JM-ACS-02 runtime bootstrap:** route `/jm/capability/issue`, a dedicated bridge worker identity, runtime
  registration and the launcher's immutable subject checked against the runtime registry.
- **JM-ACS-03 lease liveness:** Jace-Mem relies on the 30 s lifetime; a revoked lease stays usable until expiry.
- **JM-ACS-04 integration certification.**
- Migration numbering: 075 and 076 are claimed by unmerged branches; this slice uses 077.
