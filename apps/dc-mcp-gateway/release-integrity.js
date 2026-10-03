// One release verifier for ACS, DC, and the edge. Kept as a compatibility
// entrypoint for packaged gateways and existing integration imports.
export { createReleaseMetadata, runtimeIdentityDigest, verifyRelease } from '@agent-control-stack/release-integrity';
