# ACS/JC v1 Managed Capability Contract

Status: Implemented. ACS issues `acs.jc.v1` at `POST /jc/capability/issue`; the verifier is desktop-commander `src/jace-commander/contract.ts` (`JcCapabilityVerifier`) and its root privileged helper.

`acs.jc.v1` authorizes one exact Jace Commander MCP tool call. It is **identical to [`acs.dc.v1`](acs-dc-v1-capability-contract.md)** — envelope `{payload, signature, keyId}`, strict canonical JSON v1 signing bytes, Ed25519, exact payload key set, conditional `approvalId`, TTL of 30 s or less, 5 s skew, single-use `(keyId, nonce)` — except for the differences below. Everything not restated here is normative from `acs.dc.v1`. Implementations MUST fail closed.

## 1. Differences from acs.dc.v1

| Field            | `acs.dc.v1`                                                                              | `acs.jc.v1`                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `version`        | `acs.dc.v1`                                                                              | `acs.jc.v1`                                                                                       |
| `audience`       | `desktop-commander`                                                                      | `jace-commander`                                                                                  |
| scope vocabulary | `fs.read`, `fs.write`, `process.exec`, `process.spawn`, `network.read`, `network.write`  | `fs.read`, `integration.read`, `integration.write`, `process.privileged`                          |
| `invocationHash` | `sha256("acs:desktop-commander-invocation:v1\n" + canonicalJson({toolName, arguments}))` | `sha256("acs:jace-commander-invocation:v1\n" + strictCanonicalJsonV1({toolName, arguments}))`     |
| signing key      | `ACS_DESKTOP_COMMANDER_CAPABILITY_PRIVATE_KEY`                                           | `ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY` (MUST differ; ACS refuses to issue if they are equal) |
| runtime identity | §7 bootstrap handshake                                                                   | pinned by `ACS_JACE_COMMANDER_RUNTIME_ID` and the helper's root-owned config (no bootstrap yet)   |

A new version, not an extension: `acs.dc.v1` fixes its scope vocabulary and forbids `sudo`. Cross-use fails in both directions: a DC capability fails the JC version/audience checks, and DC rejects the `jace-commander` audience.

## 2. Tool table

Exactly one scope per tool. Must stay equal to desktop-commander `JC_TOOL_POLICIES` (pinned by a unit test on both sides).

| Tool                  | Scope                | `approvalId` | ACS policy action kind | Work-item risk |
| --------------------- | -------------------- | ------------ | ---------------------- | -------------- |
| `jc_status`           | `integration.read`   | absent       | `jc.read`              | low            |
| `acs_read`            | `integration.read`   | absent       | `jc.read`              | low            |
| `swarm_read`          | `integration.read`   | absent       | `jc.read`              | low            |
| `visualizer_read`     | `integration.read`   | absent       | `jc.read`              | low            |
| `acs_submit_mission`  | `integration.write`  | absent       | `jc.write`             | medium         |
| `mission_router_list` | `fs.read`            | absent       | `jc.read`              | low            |
| `looptrace_verify`    | `fs.read`            | absent       | `jc.read`              | low            |
| `privileged_exec`     | `process.privileged` | **required** | `jc.privileged_exec`   | critical       |

## 3. Arguments

`normalizedArguments` is the exact object the bridge will deliver (keys with `undefined` dropped), bound by structural equality under strict canonical JSON. ACS validates it and never rewrites it. Per-tool key allowlists mirror the Jace Commander MCP input schemas.

`privileged_exec` accepts exactly `{argv, cwd?, timeoutMs?, stdin?}`:

- `argv`: 1–256 strings, each ≤ 8192 chars without NUL. `argv[0]` is an absolute path equal to its POSIX-normalized form. No shell, no `PATH` lookup.
- `cwd`: absolute path without NUL.
- `timeoutMs`: safe integer in `[1, 600000]`.
- `stdin`: string ≤ 64 KiB.

Any other key, or any invalid value, is rejected with `jace_commander_argument_invalid` before ACS creates any work item.

## 4. Issuance (`POST /jc/capability/issue`)

Request: bearer credential for the dedicated worker identity `acs-jc-bridge` (any other identity gets 403 `jc_bridge_identity_required`). The `x-jc-actor` header names the requesting subject. The body is `{client_id, tool, argsSummary, correlationId?}`, where `argsSummary` is the JSON-encoded exact arguments. Rate limit: 120/min.

ACS then:

1. Validates the tool and arguments and computes `invocationHash`.
2. Finds or creates one work item (`requester: agent`, `requesterSubject: <x-jc-actor>`) whose single action carries the tool, `invocationHash`, the requester subject, and a keyed `bindingHash`. The binding hash is an HMAC under a key derived from the JC signing key, so an `acs:write` caller cannot pre-create a look-alike work item for the issuer to adopt. For `privileged_exec`, the action also carries `approvalDetail` (verbatim `argv`, `cwd`, `timeoutMs`, plus stdin length and SHA-256) and the intent states the exact command. This is what the human approves, and all of it is covered by the policy `actionHash`.
3. Runs policy. `jc.privileged_exec` is **always `require_approval`, never `allow`**, at every operation and risk level. Approval is denied (`deny:jc-privileged-self-approval`) when the approver is the requester or the requester subject, and denied (`deny:jc-privileged-auto-approval`) for the admin-mode auto-approver `acs:admin`. The gateway's `/work-items/:id/approve` route also returns 403 `approval_self_denied` to the requester subject. Admin execution mode never auto-approves a JC call. The generic `deny:sudo` rule is unchanged: `sudo` inside an ordinary Desktop Commander `cmd.run`/`shell` action stays forbidden. JC kinds are not offered to the Mission Control composer.
4. Answers 409 `require_approval` with `workItemId`, `actionHash` and `approvalDetail` until the work item is approved.
5. Claims the approved work item under a fresh attempt lease. The claim transactionally **consumes** the execution-plan approval. An expired or missing approval blocks the claim (403 `jace_commander_claim_rejected`).
6. Re-derives authority from trusted state: work item running, lease active and held by the bridge, fencing and plan hash match, `executionActionHash` unchanged, and invocation and binding hashes unchanged.
7. Builds the payload. For `privileged_exec`, `approvalId` is the consumed approval and `actionHash` is its approval-bound action hash. `requestHash = executionPlanApprovalRequestHash({workItemId, planHash, actionHash})`.
8. Commits a row to `jace_commander_capability_issuances` in one `BEGIN IMMEDIATE` transaction. The transaction rechecks the live lease, fencing and plan head, and requires the approval to be `consumed`, unexpired through `expiresAt`, bound to the same plan/action/request hashes, and not granted by `acs:admin`. Unique indexes allow **one capability per lease** and **one capability per approval**, so reuse fails at the database (`jace_commander_approval_reused`). Only hashes are stored, never arguments or raw nonces.
9. Appends `jace_commander.capability_issued` (or `_denied`) to the hash-chained execution audit, and a `jc-capability-issued|denied` connector-request audit record. Then it signs and returns `{decision: "allow", capability, workItemId, attemptId, leaseId, leaseEpoch, planHash, actionHash, invocationHash, workerId}`.

A second identical `privileged_exec` call after issuance creates a new work item and needs a new human approval. A different `argv`, `cwd`, `timeoutMs`, `stdin` or requester is a different invocation and a different work item: an approval never transfers.

Configuration: `ACS_JACE_COMMANDER_CAPABILITY_PRIVATE_KEY` (base64url PKCS#8 DER Ed25519), `ACS_JACE_COMMANDER_CAPABILITY_KEY_ID`, `ACS_JACE_COMMANDER_RUNTIME_ID`. If any is missing or invalid, or the key equals the DC key, the route answers 503 `capability_issuance_unconfigured` and issues nothing. Publish the matching SPKI public key to the helper as `acsPublicKey`/`acsKeyId`.

## 5. Interoperability vector

`packages/desktop-commander-adapter/src/fixtures/acs-jc-v1-interop-vector.json` is pinned byte-identically as desktop-commander `test/fixtures/acs-jc-v1-interop-vector.json`. ACS re-signs it from the seed (`jace-commander-capability.test.ts`). DC verifies it with `JcCapabilityVerifier` (`test/test-jace-commander-acs-interop.js`).

Test-only seed: `sha256("acs.jc.v1 interop vector seed v1")` as the raw 32-byte Ed25519 seed. SPKI public key (base64url): `MCowBQYDK2VwAyEAnsp5IXUnUBq1NrvXqsl49eLKQWThIMgRaR_Xa7brKnc`, key ID `acs-jc-interop-1`, runtime `jc-interop-runtime`, verified at `2026-09-26T12:00:10.000Z`.

| Case                                                                      | `invocationHash`                                                   | Signature (base64url)                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `acs_read {view:"work-items",status:"needs_approval"}`                    | `5123f725637c78423f07e037d53c60fbd320f4aeab116991f5dcfd91ee39ad38` | `HBHMFcHiO-VsFevGp8lOf_49CZjeH8jGPxVhJprL8H8cPSo9JJIqkE7bT2XNdRWBzjvCJZchxjUgxwF7aDz0Bw` |
| approved `privileged_exec` (`apt-get install -y jq`, cwd, timeout, stdin) | `8b5ae74ff8132ee4bb09863d7fbc9fe3a12bf66e80e824c609fd7874a22e1f52` | `mH39ScC34eEeLmv8M6qEniA-I26KQrnjKvkeA7CiMUWVNCvmcL-mQqWBaAZW2rtMwSs7seRIgWCkR3g_VnwLCg` |

The vector also contains an `acs.dc.v1`-shaped payload signed by the same key. The JC verifier MUST reject it (`JC_CAPABILITY_VERSION_INVALID`).

A future invocation-hash or field change requires a new version and new vectors.
