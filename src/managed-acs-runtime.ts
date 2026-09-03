import { getRuntimeIdentityState } from './runtime-identity.js';
import os from 'node:os';
import path from 'node:path';
import {
  FIXED_ACS_SCOPES,
  ManagedAcsAuthorizationError,
  ManagedAcsGuard,
  executionModeFromArgv,
  type AcsRuntimeIdentityHandshake,
  type AcsScope,
  type DesktopCommanderExecutionMode,
  type ManagedAcsAuthorizationMetadata,
} from './managed-acs.js';

let guardPromise: Promise<ManagedAcsGuard> | undefined;

export function desktopCommanderExecutionMode(): DesktopCommanderExecutionMode {
  return executionModeFromArgv(process.argv.slice(2));
}

function configuredScopes(): readonly AcsScope[] {
  const configured = process.env.DESKTOP_COMMANDER_ACS_SCOPES;
  if (!configured) return FIXED_ACS_SCOPES;
  const scopes = configured.split(',');
  if (
    scopes.length === 0
    || scopes.some((scope) => !FIXED_ACS_SCOPES.includes(scope as AcsScope))
    || scopes.some((scope, index) => index > 0 && scopes[index - 1] >= scope)
  ) {
    throw new ManagedAcsAuthorizationError('ACS_RUNTIME_IDENTITY_DRIFT');
  }
  return scopes as AcsScope[];
}

async function createGuard(): Promise<ManagedAcsGuard> {
  const identity = await getRuntimeIdentityState();
  const stateDirectory = process.env.DESKTOP_COMMANDER_STATE_DIR
    ? path.resolve(process.env.DESKTOP_COMMANDER_STATE_DIR)
    : path.join(os.homedir(), '.desktop-commander');
  return new ManagedAcsGuard({
    mode: desktopCommanderExecutionMode(),
    runtimeId: identity.runtime_id,
    publicKey: process.env.DESKTOP_COMMANDER_ACS_PUBLIC_KEY,
    keyId: process.env.DESKTOP_COMMANDER_ACS_KEY_ID,
    allowedScopes: configuredScopes(),
    replayDirectory: path.join(stateDirectory, 'acs-nonce-cache'),
  });
}

export function getManagedAcsGuard(): Promise<ManagedAcsGuard> {
  guardPromise ??= createGuard();
  return guardPromise;
}

export async function initializeManagedAcsRuntime(meta: unknown): Promise<AcsRuntimeIdentityHandshake | undefined> {
  return (await getManagedAcsGuard()).initialize(meta);
}

export async function authorizeManagedToolCall(
  toolName: string,
  args: Record<string, unknown>,
  meta: unknown,
): Promise<ManagedAcsAuthorizationMetadata | undefined> {
  return (await getManagedAcsGuard()).authorize(toolName, args, meta);
}

export async function revokeManagedAcsRuntime(): Promise<void> {
  (await getManagedAcsGuard()).revoke();
}

export function managedAuthorizationErrorResult(error: ManagedAcsAuthorizationError) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: {
          code: error.code,
          message: 'Desktop Commander managed authorization rejected',
        },
      }),
    }],
    isError: true,
    _meta: {
      acsAuthorization: {
        version: 'acs.dc.v1',
        mode: 'managed',
        decision: 'denied',
        code: error.code,
      },
    },
  };
}

export function managedAuthorizationSuccessMeta(metadata: ManagedAcsAuthorizationMetadata | undefined) {
  if (!metadata) {
    return {
      desktopCommanderMode: 'standalone',
      acsAuthorization: {
        mode: 'standalone',
        decision: 'not-required',
      },
    };
  }
  return {
    desktopCommanderMode: 'managed',
    acsAuthorization: {
      ...metadata,
      mode: 'managed',
      decision: 'granted',
    },
  };
}
