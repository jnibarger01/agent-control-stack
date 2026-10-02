# Release integrity

The source-controlled verifier is `@agent-control-stack/release-integrity`.
`scripts/release-integrity.mjs` is its operator CLI, and the DC gateway's
`release-integrity.js` is a compatibility export of the same implementation.
Verification does not deploy, change the runtime registry, or restart a service.

## Verify an existing artifact

```bash
npm run release:integrity -- verify /absolute/releases/acs/<commit-prefix>-<label>
npm run release:integrity -- verify /absolute/releases/dc/<label>
npm run release:integrity -- verify /absolute/releases/dc-mcp-gateway/<label>
```

Verification checks the full file manifest, runtime identity digest, dependency
digest, component path, commit metadata, and pinned Node executable. The recorded
Node hash is checked before running that executable's `--version`. Workspace
links in ACS must stay inside its release; standalone DC and gateway dependency
links must stay inside their `node_modules` directory. External links fail closed.

These hashes detect drift against the recorded artifact. They are not a signed
attestation of source provenance: a writer able to replace both metadata and
runtime files remains inside the trust boundary. Protect release directories
and compare the runtime identity with the separately governed registry.

## Seal a new staged artifact

Build from the exact reviewed commit, install its locked dependencies, and place
the artifact beneath `/absolute/releases/_staging/<unique-label>`. Pin Node at
`/absolute/releases/_node/<version>/bin/node`. Then create and verify metadata:

```bash
npm run release:integrity -- create /absolute/releases/_staging/<unique-label> <full-commit-sha> /absolute/releases/_node/v24.18.0/bin/node acs
npm run release:integrity -- verify /absolute/releases/_staging/<unique-label> --allow-staging
```

Choose `dc` or `gateway` for those components. Creation refuses either existing
metadata file, including a partial pair or dangling link. Exclusive creation
also prevents concurrent writers from overwriting a seal. A failure can leave a
partial pair; verification rejects it. Inspect the staging artifact rather than
resealing a changed published release. Creation records the supplied commit;
it does not independently prove that the artifact was built from that commit.
Never label an uncommitted source snapshot as the released HEAD.

Publication and service rollout require their own review and authorization.
Published ACS directory names must start with the recorded seven-character
commit prefix. Published component parents are `acs`, `dc`, and
`dc-mcp-gateway`. Verification rejects component/path mismatch.

## Standalone gateway packaging

The DC gateway depends on `@agent-control-stack/release-integrity`. Include that
package's `package.json` and `src/index.js` as an installed dependency inside the
gateway release's `node_modules/@agent-control-stack/release-integrity`.
A workspace link back into a source checkout is not a valid standalone release.
Copying only the gateway's top-level JavaScript files is insufficient.
The dependency manifest must include the verifier itself.

For managed DC, the bridge must use the verified DC `runtimeIdentityDigest`,
not the hash of `dist/index.js`. See
[managed mode](../../apps/dc-mcp-gateway/docs/acs-managed-mode.md#release-identity-binding).
Do not change a registered fingerprint to accommodate an inconsistent bridge.

## Validation

```bash
npm run test:release-integrity
node --test apps/dc-mcp-gateway/test/release-identity.test.mjs
npm run check
```

Local checks do not prove that the running service uses the new verifier.
Inspect the effective service executable, working directory, release metadata,
and functional bootstrap before declaring runtime recovery.
