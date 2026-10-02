#!/usr/bin/env node
import { createReleaseMetadata, verifyRelease } from '@agent-control-stack/release-integrity';

try {
  const args = process.argv.slice(2);
  const [mode, directory, commitOrOption, nodePath, component = 'acs'] = args;
  const usage = 'usage: release-integrity.mjs create <dir> <commit> <pinned-node> [acs|dc|gateway] | verify <dir> [--allow-staging]';
  let release;
  if (mode === 'create' && (args.length === 4 || args.length === 5)) {
    release = createReleaseMetadata(directory, { commit: commitOrOption, nodePath, component });
  } else if (mode === 'verify' && (args.length === 2 || (args.length === 3 && commitOrOption === '--allow-staging'))) {
    release = verifyRelease(directory, { allowStaging: commitOrOption === '--allow-staging' });
  } else {
    throw new Error(usage);
  }
  console.log(JSON.stringify({
    commit: release.commit,
    component: release.component ?? 'dc',
    runtimeIdentityDigest: release.runtimeIdentityDigest,
    fullManifestDigest: release.fullManifestDigest,
    dependencyDigest: release.dependencyDigest,
  }));
} catch (error) {
  console.error(`release integrity: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
