/**
 * WebAuthn passkey verifier for approverd privileged approvals (Jace's decision 2026-10-13; #355 F3).
 *
 * - Phishing resistant: signatures, RP ID hash, origin, challenge, type, UP and UV flags are verified by
 *   @simplewebauthn/server (no hand-rolled CBOR/COSE). RP ID and origin are pinned from approverd config.
 * - User verification is REQUIRED (UV=1, which implies UP=1); a UV=0 assertion is a denial.
 * - Trust anchor: the registered credential public keys live in a ROOT-OWNED file read through the same
 *   root-controlled-file check as the JC local policy (file and every parent root-owned, not group/world
 *   writable, symlink-safe, O_NOFOLLOW + fstat). It is re-read on every verification, so a revoked key is
 *   gone at once, and any problem with it is a denial. Agents can never register keys: approverd has no
 *   registration op; `jace-commander passkey-register` only writes a file the operator installs as root.
 * - Replay: the WebAuthn challenge is derived from the single-use gate challenge (webauthnChallengeFor), and
 *   signCount must strictly increase whenever either value is nonzero. Counters persist in approverd's own
 *   state dir (the root-owned anchor is read-only by design).
 * - The returned principal is the operator the credential id is registered to; if the authenticator also
 *   returns a user handle it must equal the registered one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { webauthnChallengeFor, type JcApprovalChallenge, type JcHumanAssertion, type JcHumanVerifier, type JcVerifiedPrincipal } from './approval-protocol.js';
import { readRootControlledFile, type RootControlledFileIo } from './root-controlled-file.js';

export const JC_PASSKEY_TRUST_ANCHOR_VERSION = 'jc.passkeys.v1';
export const MAX_TRUST_ANCHOR_BYTES = 64 * 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;
const OPERATOR_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface JcPasskeyCredential {
  /** base64url credential id. */
  credentialId: string;
  /** base64url COSE public key, as produced by verifyRegistrationResponse. */
  publicKey: string;
  /** base64url WebAuthn user handle (user.id) the credential was registered with. */
  userHandle: string;
  /** The approver principal recorded in the audit. */
  operatorId: string;
  transports?: string[];
  registeredAt?: string;
}

export interface JcPasskeyTrustAnchor {
  version: typeof JC_PASSKEY_TRUST_ANCHOR_VERSION;
  credentials: JcPasskeyCredential[];
}

function b64url(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && B64URL.test(value);
}

export function parsePasskeyTrustAnchor(raw: string): JcPasskeyTrustAnchor {
  const json = JSON.parse(raw) as Record<string, unknown>;
  if (!json || typeof json !== 'object' || json.version !== JC_PASSKEY_TRUST_ANCHOR_VERSION || !Array.isArray(json.credentials)) {
    throw new Error('passkey trust anchor: bad version or shape');
  }
  const seen = new Set<string>();
  const credentials = json.credentials.map((entry: unknown) => {
    const c = entry as Record<string, unknown>;
    if (!c || typeof c !== 'object' || !b64url(c.credentialId, 1024) || !b64url(c.publicKey) || !b64url(c.userHandle, 128)
      || typeof c.operatorId !== 'string' || !OPERATOR_ID.test(c.operatorId)) {
      throw new Error('passkey trust anchor: malformed credential');
    }
    if (seen.has(c.credentialId as string)) throw new Error('passkey trust anchor: duplicate credential');
    seen.add(c.credentialId as string);
    return {
      credentialId: c.credentialId as string, publicKey: c.publicKey as string, userHandle: c.userHandle as string, operatorId: c.operatorId as string,
      ...(Array.isArray(c.transports) ? { transports: c.transports.filter((t): t is string => typeof t === 'string') } : {}),
    };
  });
  if (credentials.length === 0) throw new Error('passkey trust anchor: no credentials');
  return { version: JC_PASSKEY_TRUST_ANCHOR_VERSION, credentials };
}

/** Reads the root-owned trust anchor (same root-controlled check as the JC local policy). */
export function loadPasskeyTrustAnchor(file: string, io?: RootControlledFileIo): JcPasskeyTrustAnchor {
  return parsePasskeyTrustAnchor(readRootControlledFile(file, MAX_TRUST_ANCHOR_BYTES, { io, accountLabel: 'approverd account' }));
}

export interface JcSignCountStore {
  get(credentialId: string): number;
  set(credentialId: string, counter: number): void;
}

export class MemorySignCountStore implements JcSignCountStore {
  private readonly counts = new Map<string, number>();
  get(id: string): number { return this.counts.get(id) ?? 0; }
  set(id: string, counter: number): void { this.counts.set(id, counter); }
}

/** Counters in approverd's state dir: 0600 JSON, written atomically (temp + fsync + rename). */
export class FileSignCountStore implements JcSignCountStore {
  constructor(private readonly file: string) {}

  private read(): Record<string, number> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) if (Number.isSafeInteger(v) && (v as number) >= 0) out[k] = v as number;
      return out;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      // A corrupt counter file must not silently reset counters to 0 (that would re-open replay).
      throw new Error('passkey sign-count store unreadable');
    }
  }

  get(id: string): number {
    return this.read()[id] ?? 0;
  }

  set(id: string, counter: number): void {
    const all = this.read();
    all[id] = counter;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(all));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.file);
  }
}

export interface JcPasskeyVerifierOptions {
  rpId: string;
  origin: string;
  loadTrustAnchor: () => JcPasskeyTrustAnchor;
  signCounts: JcSignCountStore;
}

/** Validates the pinned RP ID / origin pair. The origin's host must be the RP ID or a subdomain of it. */
export function assertPasskeyRelyingParty(rpId: unknown, origin: unknown): void {
  if (typeof rpId !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(rpId)) throw new Error('passkey rpId must be a lowercase hostname');
  if (typeof origin !== 'string') throw new Error('passkey origin is required');
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('passkey origin must be a URL');
  }
  if (url.origin !== origin) throw new Error('passkey origin must be a bare origin (scheme://host[:port])');
  const local = url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('passkey origin must be https (or http://localhost)');
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) throw new Error('passkey origin host must equal or be a subdomain of rpId');
}

function responseShape(value: unknown): value is AuthenticationResponseJSON {
  const r = value as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object' || r.type !== 'public-key' || !b64url(r.id, 1024) || r.rawId !== r.id) return false;
  const inner = r.response as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== 'object') return false;
  if (!b64url(inner.clientDataJSON, 8192) || !b64url(inner.authenticatorData, 8192) || !b64url(inner.signature, 1024)) return false;
  if (inner.userHandle !== undefined && inner.userHandle !== null && !b64url(inner.userHandle, 128)) return false;
  return true;
}

export class JcPasskeyVerifier implements JcHumanVerifier {
  constructor(private readonly options: JcPasskeyVerifierOptions) {
    assertPasskeyRelyingParty(options.rpId, options.origin);
    if (typeof options.loadTrustAnchor !== 'function' || !options.signCounts) throw new TypeError('trust anchor loader and sign-count store are required');
  }

  /** Credential ids for the browser's allowCredentials; throws if the anchor cannot be loaded. */
  allowCredentials(): Array<{ id: string; transports?: string[] }> {
    return this.options.loadTrustAnchor().credentials.map((c) => ({ id: c.credentialId, ...(c.transports ? { transports: c.transports } : {}) }));
  }

  precheck(assertion: JcHumanAssertion): boolean {
    return responseShape(assertion.webauthn);
  }

  async verify(assertion: JcHumanAssertion, challenge: JcApprovalChallenge): Promise<JcVerifiedPrincipal | false> {
    const response = assertion.webauthn;
    if (!responseShape(response)) return false;
    const anchor = this.options.loadTrustAnchor(); // throws => denial (fail closed)
    const credential = anchor.credentials.find((c) => c.credentialId === response.id);
    if (!credential) return false;
    const handle = response.response.userHandle;
    if (handle !== undefined && handle !== null && handle !== credential.userHandle) return false;
    const before = this.options.signCounts.get(credential.credentialId);
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: webauthnChallengeFor(challenge),
      expectedOrigin: this.options.origin,
      expectedRPID: this.options.rpId,
      expectedType: 'webauthn.get',
      credential: { id: credential.credentialId, publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')), counter: before },
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    });
    if (result.verified !== true || result.authenticationInfo.userVerified !== true) return false;
    if (result.authenticationInfo.credentialID !== credential.credentialId) return false;
    if (result.authenticationInfo.origin !== this.options.origin || result.authenticationInfo.rpID !== this.options.rpId) return false;
    // Re-read after the await: a concurrent verification may have advanced the counter meanwhile.
    const counter = result.authenticationInfo.newCounter;
    const current = this.options.signCounts.get(credential.credentialId);
    if (!Number.isSafeInteger(counter) || counter < 0) return false;
    if ((counter > 0 || current > 0) && counter <= current) return false;
    this.options.signCounts.set(credential.credentialId, counter);
    return { operatorId: credential.operatorId, credentialId: credential.credentialId, assurance: 'webauthn-uv' };
  }
}
