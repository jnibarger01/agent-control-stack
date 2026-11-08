#!/usr/bin/env node
/**
 * Passkey registration for approverd privileged approvals (Jace's decision 2026-10-13).
 *
 *   node dist/jace-commander/passkey-register.js --rp-id localhost --origin http://localhost:7391 \
 *     --operator jace --out ./passkeys.json [--from /etc/jace-commander/passkeys.json]
 *
 * Run by the human operator, physically present, in their own session. It serves a one-shot local page
 * (passkey-ceremony.ts) that creates a passkey with user verification REQUIRED, verifies the registration
 * with @simplewebauthn/server, and writes a NEW trust-anchor file (existing credentials from --from, plus
 * the new one) to --out. It never overwrites a file and never writes the installed trust anchor itself:
 * the operator reviews --out and installs it as root, e.g.
 *
 *   sudo install -o root -g root -m 0644 ./passkeys.json /etc/jace-commander/passkeys.json
 *
 * approverd has no registration operation, so no agent or socket client can add a key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { runLocalCeremony } from './passkey-ceremony.js';
import { JC_PASSKEY_TRUST_ANCHOR_VERSION, assertPasskeyRelyingParty, parsePasskeyTrustAnchor, type JcPasskeyCredential } from './passkey-verifier.js';

const OPERATOR_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const rpId = flag(argv, '--rp-id');
  const origin = flag(argv, '--origin');
  const operator = flag(argv, '--operator');
  const out = flag(argv, '--out');
  const from = flag(argv, '--from');
  if (!rpId || !origin || !operator || !out) {
    process.stderr.write('usage: passkey-register --rp-id <id> --origin <origin> --operator <id> --out <new file> [--from <existing anchor>]\n');
    return 2;
  }
  assertPasskeyRelyingParty(rpId, origin);
  if (!OPERATOR_ID.test(operator)) throw new Error('--operator must match [A-Za-z0-9._:-]{1,128}');
  if (fs.existsSync(out)) throw new Error(`${out} exists; choose a new output path (this tool never overwrites)`);
  const existing: JcPasskeyCredential[] = from ? parsePasskeyTrustAnchor(fs.readFileSync(from, 'utf8')).credentials : [];
  const userId = crypto.randomBytes(32);
  const options = await generateRegistrationOptions({
    rpName: 'Jace Commander approvals',
    rpID: rpId,
    userName: operator,
    userID: new Uint8Array(userId),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    timeout: 120_000,
  });
  const response = await runLocalCeremony({
    mode: 'create',
    origin,
    options: options as unknown as Record<string, unknown>,
    timeoutMs: 120_000,
    summary: `Register a passkey for operator ${operator} (rpId ${rpId})`,
    onUrl: (url) => process.stderr.write(`Open on this machine and create the passkey: ${url}\n`),
  });
  const verified = await verifyRegistrationResponse({
    response: response as unknown as RegistrationResponseJSON,
    expectedChallenge: options.challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
  });
  if (!verified.verified || !verified.registrationInfo) throw new Error('registration did not verify');
  const { credential } = verified.registrationInfo;
  const entry: JcPasskeyCredential = {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    userHandle: userId.toString('base64url'),
    operatorId: operator,
    ...(credential.transports ? { transports: credential.transports } : {}),
    registeredAt: new Date().toISOString(),
  };
  const anchor = { version: JC_PASSKEY_TRUST_ANCHOR_VERSION, credentials: [...existing, entry] };
  parsePasskeyTrustAnchor(JSON.stringify(anchor));
  const fd = fs.openSync(out, 'wx', 0o644);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(anchor, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  process.stdout.write(`wrote ${out} (${anchor.credentials.length} credential(s)). Install it as root:\n  sudo install -o root -g root -m 0644 ${out} <passkey.trustAnchorPath>\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${fs.realpathSync(process.argv[1])}`).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stderr.write(`passkey-register: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exit(1);
  });
}
