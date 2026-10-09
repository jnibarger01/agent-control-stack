/** Manifest-backed provider mapping; no provider depends on ACS health. */
import { JC_MANIFEST } from './manifest.generated.js';

export const JC_PROVIDER_IDS = [
  'jc.fs', 'jc.git', 'jc.process', 'jc.privileged',
  'jc.meta', 'jc.integration', 'acs',
] as const;
export type JcProviderId = typeof JC_PROVIDER_IDS[number];

const GROUP_PROVIDER: Readonly<Record<string, JcProviderId>> = Object.freeze({
  filesystem: 'jc.fs',
  search: 'jc.fs',
  git: 'jc.git',
  process: 'jc.process',
  privileged: 'jc.privileged',
  system: 'jc.meta',
  mission: 'jc.meta',
  swarm: 'jc.integration',
  visualizer: 'jc.integration',
  acs: 'acs',
});

export function providerForGroup(group: string): JcProviderId {
  if (!Object.prototype.hasOwnProperty.call(GROUP_PROVIDER, group)) {
    throw new Error(`JC provider mapping missing manifest group: ${group}`);
  }
  return GROUP_PROVIDER[group];
}

export const JC_TOOL_PROVIDERS: Readonly<Record<string, JcProviderId>> = Object.freeze(
  Object.fromEntries(JC_MANIFEST.tools.map((tool) => [tool.name, providerForGroup(tool.group)])) as Record<string, JcProviderId>,
);

export const JC_PROVIDER_REGISTRY: Readonly<Record<JcProviderId, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    JC_PROVIDER_IDS.map((id) => [
      id, Object.freeze(JC_MANIFEST.tools.filter((tool) => JC_TOOL_PROVIDERS[tool.name] === id).map((tool) => tool.name)),
    ]),
  ) as Record<JcProviderId, readonly string[]>,
);

export function providerForTool(name: string): JcProviderId | undefined {
  return Object.prototype.hasOwnProperty.call(JC_TOOL_PROVIDERS, name) ? JC_TOOL_PROVIDERS[name] : undefined;
}

export function assertJcProviderCoverage(handlerNames: readonly string[]): void {
  const expected = JC_MANIFEST.tools.map((tool) => tool.name).sort();
  const actual = [...handlerNames].sort();
  const mapped = Object.keys(JC_TOOL_PROVIDERS).sort();
  if (expected.join(',') !== actual.join(',') || expected.join(',') !== mapped.join(',')) {
    throw new Error('JC provider registry drift: handlers, manifest, and mapped tools must match');
  }
  for (const id of JC_PROVIDER_IDS) {
    if (JC_PROVIDER_REGISTRY[id].length === 0) throw new Error(`JC provider has no tools: ${id}`);
  }
}
