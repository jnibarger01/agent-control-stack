# Jace Commander: passkey approvals (jc.decide.v2)

Status: implemented and opt-in. Decided by Jace on 2026-10-13. Addresses the #355 review findings F1 to F5 and R/V's findings in #356.

## What it does

The `passkey` block is **required**: approverd refuses to start without it. Approving a **privileged** request always requires a phishing-resistant WebAuthn passkey assertion with **user verification** (UV=1, which implies UP=1). `requiredRiskClasses` only *adds* classes to `privileged`; it can never remove it. The only way to run without passkeys is the explicit opt-out `"allowSelfAssertedPrivileged": true` (in place of the `passkey` block), which approverd records in its audit chain on every start and refuses to start if it cannot. Before this, `approverIdAssurance` was `self-asserted`; such approvals are now audited with the authenticated principal and `approverIdAssurance: 'webauthn-uv'`. Everything that existed before is unchanged: the socket groups, the TTY and typed-hash confirmation, the hash-chained audit, single-use claims and the 30 s tokens.

```json
"passkey": {
  "trustAnchorPath": "/etc/jace-commander/passkeys.json",
  "rpId": "localhost",
  "origin": "http://localhost:7391",
  "requiredRiskClasses": ["mutate"],
  "verifierTimeoutMs": 10000
}
```

The RP ID and origin are pinned here. The origin's host must be the RP ID or one of its subdomains, and the origin must be `https`, or `http://localhost`.

## Protocol (decide.sock, `protocol: "jc.decide.v2"`)

1. `decide_begin {id, confirmHash}`: approve-cli sends this after it shows the request and before it prompts. approverd checks that the record is pending and that the hash matches, then issues a **single-use 32-byte challenge** valid for **30 s**. The challenge is capped at the record's own 15-minute expiry. While a challenge is live, a second `decide_begin` is refused with `CHALLENGE_LIVE` (F4). Expired challenges are swept on every issue (F5). The reply carries the WebAuthn challenge, which is `SHA-256("jc.approval.webauthn.v1" ‖ len-prefixed gate challenge, approval id, runtime, tool, invocation hash, record expiresAt, challenge issuedAt/expiresAt)`, together with the pinned RP ID and origin and the `allowCredentials` list.
2. `decide_complete {id, decision:"approve", assertion}`: the assertion carries the gate fields and the WebAuthn `AuthenticationResponseJSON`.
   - Malformed input is denied **without** consuming the challenge (F4).
   - A structurally valid assertion consumes the challenge. Then @simplewebauthn/server checks the signature, RP ID hash, origin, type, challenge, and the UP and UV flags.
   - The sign counter must strictly increase whenever it is nonzero. Counters are kept in `<stateDir>/passkey-counters.json`.
   - The verifier runs against a deadline. A timeout is a denial that leaves the record pending (#356 f).
   - A clock that runs backwards is a denial (#356 b).
   - The verifier returns the principal: the `operatorId` that the credential id and user handle are registered to. It must equal the claimed operator (F2).
   - In the same synchronous step that sets `approved`, approverd re-reads the live record and requires it to still be pending and unexpired, with the same hash and the same expiry (F1).

While `passkey` is configured, a legacy one-step `decide` approving a passkey-required class gets `PASSKEY_REQUIRED`. That decision depends only on the configuration, so it fails closed even when the trust anchor is missing or broken. Rejecting through `decide` remains possible, because a rejection can only deny.

## Trust anchor (root-owned)

The anchor is `{ "version": "jc.passkeys.v1", "credentials": [{ credentialId, publicKey (COSE, base64url), userHandle, operatorId, transports? }] }`. It is read on **every** verification through the same root-controlled check as the JC local policy (`root-controlled-file.ts`):

- The file and every parent up to `/` must be owned by root.
- Nothing in that chain may be group- or world-writable, owned by approverd's account, or writable by it.
- A symlink is followed only if root owns it and it resolves to a root chain.
- The file is opened with `O_NOFOLLOW` and checked with `fstat` against the inode that was checked.

If anything fails, approvals for passkey-required classes are impossible (fail closed).

## Installing

If `passkey` is configured and the library is missing, approverd refuses to start, which fails closed. Run `npm ci` and `npm run build` in `vendor/desktop-commander`, then as root (Jace):

```sh
sudo deploy/jace-commander/install-approverd.sh
```

The installer copies `passkey-verifier.js` and `root-controlled-file.js`, installs the pinned `@simplewebauthn/server` and its runtime dependencies root-owned under `/opt/jace-commander/node_modules` (from the repo's `node_modules`; nothing is fetched), and writes a `passkey` block (`JC_PASSKEY_RP_ID`, default `localhost`; `JC_PASSKEY_ORIGIN`, default `http://localhost:7391`). Until a passkey is registered, privileged approvals fail closed. `JC_ALLOW_SELF_ASSERTED_PRIVILEGED=1` writes the audited opt-out instead.

## Registration (needs Jace physically present; agents never register)

approverd has no registration operation. Run this as yourself, at the machine:

```sh
node vendor/desktop-commander/dist/jace-commander/passkey-register.js \
  --rp-id localhost --origin http://localhost:7391 --operator jace --out ~/passkeys.new.json \
  [--from /etc/jace-commander/passkeys.json]     # keep existing keys
# open the printed http://localhost:7391/<token> URL in a browser on this machine,
# create the passkey (Touch ID / Windows Hello / security key with PIN)
sudo install -o root -g root -m 0644 ~/passkeys.new.json /etc/jace-commander/passkeys.json
```

The tool verifies the registration with UV required and never overwrites a file. Then add the `passkey` block to approverd's config and restart approverd yourself. To revoke a key, remove its entry and reinstall the file. It takes effect on the next verification.

## Approving

Run `JC_APPROVER_ID=jace jace-commander approve <id>` on a real terminal. `JC_APPROVER_ID` must equal the registered `operatorId`; the default is your OS username. The command:

1. Shows the request.
2. Starts the 30 s window.
3. Asks for the hash prefix.
4. Prints a one-time `http://localhost:7391/<token>` URL. Open it on the same machine and use the passkey.
5. Sends the assertion.

The page server binds 127.0.0.1 only. It accepts one result from the pinned origin and stops at the challenge deadline. Only `http://localhost:<port>` origins are supported by this built-in page; an `https` origin needs an operator-run TLS front end.
