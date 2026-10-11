/**
 * Per-call authorizer selection. Presets retain shipped behavior:
 * managed => ACS; standalone => local read-only, other calls refused.
 * Admin delegation is explicit by provider or tool, never a global fallback.
 */
import { JC_TOOL_POLICIES } from './contract.js';
import { providerForTool, type JcProviderId } from './providers.js';

export type JcAuthorizer = 'local' | 'acs-capability' | 'admin-delegated';
export type JcAuthorizerDecision = JcAuthorizer | 'refused';
export type JcAuthorizerPreset = 'managed' | 'standalone' | 'local';

export interface JcAuthorizerOverrides {
  perTool?: Readonly<Record<string, JcAuthorizer>>;
  perProvider?: Partial<Readonly<Record<JcProviderId, JcAuthorizer>>>;
  defaultAuthorizer?: Exclude<JcAuthorizer, 'admin-delegated'>;
}

export function resolveJcAuthorizer(
  name: string,
  preset: JcAuthorizerPreset,
  overrides: JcAuthorizerOverrides = {},
  allowLocalNonRead = false,
): JcAuthorizerDecision {
  const policy = Object.prototype.hasOwnProperty.call(JC_TOOL_POLICIES, name) ? JC_TOOL_POLICIES[name] : undefined;
  const provider = providerForTool(name);
  if (!policy || !provider) return 'refused';
  const toolOverride = overrides.perTool && Object.prototype.hasOwnProperty.call(overrides.perTool, name)
    ? overrides.perTool[name] : undefined;
  const providerOverride = overrides.perProvider && Object.prototype.hasOwnProperty.call(overrides.perProvider, provider)
    ? overrides.perProvider[provider] : undefined;
  const selected = toolOverride ?? providerOverride ?? overrides.defaultAuthorizer
    ?? (preset === 'managed' ? 'acs-capability' : 'local');

  // Until the policy gate, approval signer and root-helper trust anchors exist,
  // a local authorizer may ONLY authorize non-approval read-scope tools.
  if (selected === 'local') {
    if (!allowLocalNonRead && (policy.requiresApproval || policy.scopes.length === 0 || !policy.scopes.every((scope) => scope.endsWith('.read')))) {
      return 'refused';
    }
  }
  // This is authorizer selection, not a grant. Server/edge MUST independently
  // verify a current, tool-bound admin capability before executing this path.
  if (selected === 'admin-delegated' && toolOverride !== 'admin-delegated' && providerOverride !== 'admin-delegated') {
    return 'refused';
  }
  return selected;
}
