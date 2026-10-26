# Jace Commander public ingress and service isolation

Status: STAGED, NOT ACTIVATED. Do not expose the existing OAuth gateway directly via Funnel.

## Trust boundaries
- Public Funnel may proxy **only** `http://127.0.0.1:8011` (the filtered ingress). Never proxy `:8010`, `:8003`, or ACS `:3000`. Funnel is currently off.
- `acs-ingress`: zero secrets, accepts HTTP on `127.0.0.1:8011`; exact route/method/lane allowlist, deny everything else.
- `acs-edge`: OAuth signing key, consent password and execution gateway token, private `:8010`; no access to ACS signing key or JC worker token.
- `acs-jc`: managed bridge, its own worker token and scoped filesystem, private `:8003`. This bridge currently spawns a local executor: **not separated by UID yet**. It must be redesigned to use a separately authenticated executor transport before privileged runtime exposure.
- `acs-core`: ACS authorization, capability signing keys, state DB, private `:3000`. Only this user gets ACS private keys.

## Why these units are not safe to enable yet
1. The existing user-level services and manually launched ACS already own the target ports. Replacement without a verified handoff would break live sessions.
2. The repo and Node modules are inside `/home/jacen` (mode 0700) and cannot be accessed by dedicated users. A reviewed, immutable, root-owned runtime snapshot must exist under `/opt/acs-runtime/current`; no symlink to a mutable home checkout.
3. Root must provision the four separate system accounts, groups and private credential files. Use root-owned `/etc/acs-secrets/*.env`, readable by **only** their designated service groups, not a shared group.
4. Safely migrate existing OAuth data (client registrations, active refresh tokens), ACS DB and runtime state into distinct `StateDirectory` locations with a backup, ownership correction, checksums, and explicit paths. Do not reset production state.
5. Separate the **JC executor** from bridge secrets and runtime identity. The current bridge's `StdioClientTransport` spawns the executor locally. Moving only the bridge UID leaves the executor able to inspect the bridge process and secrets; it also loses access to the user's desktop/workspaces. Implement authenticated cross-UID execution, or a narrowly constrained, audited broker, before allowing privileged tool calls. Test denial of cross-UID reads and capability forgery.

## Cutover acceptance gate
- All systemd units verify syntactically, then run under four distinct UIDs; isolated executor must be a fifth UID or separate, authority-constrained user session.
- `systemctl show` confirms each `User`, sandbox settings, service PID and owner; `/proc/<pid>/environ` and credential files unreadable across identities; no shared credentials.
- Private service endpoints still answer locally and JC read/execute tools operate through ACS-issued, short-lived, single-use capabilities.
- Ingress denies `/`, `/mcp`, `/ready`, `/authority`, `/jc/ready`, `/health`, ACS paths, DC OAuth discovery, unknown methods and non-JC OAuth lanes. Only JC endpoints pass.
- Negative OAuth tests: wrong issuer/audience, malformed PKCE, unregistered redirect URI, expired token, forged token, wrong client, refresh reuse, replay, unavailable ACS. Denial must have no side effects.
- Verify a fresh ChatGPT JC OAuth sign-in and existing sessions before any public Funnel enablement. Route `/` must never point at `:8010`.
- Roll back by stopping the **new** system units and restoring backed-up state and pre-cutover private services. Do not perform a rollback without checking database divergence/active tokens.

## Current implementation
- `apps/dc-mcp-gateway/public-edge-policy.js`: pure allowlist with tests.
- `apps/dc-mcp-gateway/public-edge-proxy.js`: private loopback proxy, no credentials; pinned `127.0.0.1:8010` upstream.
- `ops/jc-hardening/*.service`: staging templates. Root installation, credentials, state migration, and executor separation are **not** done.
- Source tests: `cd apps/dc-mcp-gateway && npm test`; systemd syntax check: `systemd-analyze verify ops/jc-hardening/*.service`.

Hard rule: test and approve isolated services and the public route boundary **before** enabling Funnel. Never treat `No serve config` as permission to enable an unrestricted route.
