# CI Credential-Storage Matrix Assessment (JCA2 / jace-commander)

**Scope:** Assessment of Linux/macOS/Windows credential-storage coverage for JCA2-related credential handling (Secret Service, Keychain, DPAPI, encrypted-file fallback).  
**This document separates implementation/config assessment from verified behavior.** No production credentials accessed.

## Sources read (W5 worktree, read-only unless noted)

- `.github/workflows/check.yml` — CI jobs, runners, test commands
- `.github/workflows/dc-execution-chain.yml` — additional ubuntu-only workflow
- `.github/workflows/testdriver.yml` — additional ubuntu-only workflow
- `apps/jace-commander/src/secret-store.ts` — backend implementations (`SecretServiceStore`, `KWalletStore`, `KeychainStore`, `WindowsCredentialStore`, `EncryptedFileStore`, `createSecretStore`)
- `apps/jace-commander/test/secret-store.test.mjs` — unit tests with injected/mocked `exec`
- `apps/jace-commander/README.md` — documented backend selection/fallback behavior
- `tests/jace-cli-auth-v2/e2e-cli-integration.test.mjs` — E2E CLI integration (includes live Linux Secret Service round-trip on host when available)
- `tests/jace-cli-auth-v2/storage-and-redaction.test.ts` — storage/redaction/security tests (Vitest)
- `package.json` — `test`, `test:vitest`, `test:jc-native`, `check` scripts

## Sources read (W6 worktree, read-only coordination)

- `/home/jacen/projects/.worktrees/jca2-release-closure/w6-platform-credential` tree listing (no `verification/jca2-release-closure/*` artifact found at assessment time)
- `/home/jacen/projects/.worktrees/jca2-release-closure/w6-platform-credential/STATE.md` (repo state/history; not a JCA2 platform-credential closure report)
- `/home/jacen/projects/.worktrees/jca2-release-closure/w6-platform-credential/apps/jace-commander/src/secret-store.ts`, `test/secret-store.test.mjs`, `README.md` (implementation/test presence consistent with baseline; searched for credential/keychain/matrix terms)
- `/home/jacen/projects/.worktrees/jca2-release-closure/w6-platform-credential/verification/` contents (`governed-dispatch/*`, `jc-final-hardening-20261104.md`, `jc-release-standalone-evidence.json` — no Linux/macOS/Windows credential matrix evidence observed)

## Current CI posture (implementation/config assessment)

| Workflow | Runner(s) | Relevant commands | Credential-storage coverage implication |
|---|---|---|---|
| `.github/workflows/check.yml` | `ubuntu-latest` | `npm ci`, `npm run check`, `npm run test:coverage`, `npm run security:secrets`, docker build, compose smoke | Linux-only automated environment; no macOS/Windows jobs; no explicit credential-backend matrix dimensions. |
| `.github/workflows/dc-execution-chain.yml` | `ubuntu-latest` | vendor DC build/tests, ACS build, `ACS_DC_E2E=1 npx vitest run tests/e2e` | Linux-only; unrelated to OS keychain backends except any incidental Linux behavior. |
| `.github/workflows/testdriver.yml` | `ubuntu-latest` | `npm ci`, build, `npx vitest run` | Linux-only Vitest run. |

**Conclusion (config):** There is **no Linux/macOS/Windows credential-storage CI matrix** today. Existing CI is Ubuntu-only and exercises tests that may use mocked stores, encrypted-file fallback, or (on suitable hosts) live Linux Secret Service depending on environment.

## Verification taxonomy (required separation)

### (a) Mocked verification
- **What:** Unit tests that inject fake `exec`/command runners to assert command selection, argv/stdin handling, parsing, and error behavior without calling real OS credential services.
- **Evidence in repo:** `apps/jace-commander/test/secret-store.test.mjs` (covers `EncryptedFileStore`, `SecretServiceStore` mocked via exec, `KWalletStore`/`KeychainStore`/`WindowsCredentialStore` mocked via exec, and headless fallback selection/fail-closed keyring forcing).
- **W5 observed behavior:** `npm run test:jc-native` includes `secret-store.test.mjs` in its suite list and reported 39/40 suites passed overall; `secret-store.test.mjs` itself was not the failing suite in captured run (failure was `workload-isolation.test.mjs`). Treat as **observed in this environment only insofar as jc-native suite execution passed that file**; exact per-assertion output is within `jc-native` logs.
- **Limitation:** Mocks do **not** prove real `secret-tool`/D-Bus, macOS `security`, or Windows DPAPI/PowerShell integration on native platforms.

### (b) Automated platform verification (CI-runnable, non-interactive where feasible)
- **What exists today:** Ubuntu CI can automatically run mocked tests, encrypted-file fallback tests, and Linux Secret Service tests **only when** a reachable/unlocked Secret Service session is available in the runner environment (typically not guaranteed on headless CI without setup).
- **What is proposed but not implemented in repo:** A GitHub Actions matrix such as:
  - `ubuntu-latest`: run `apps/jace-commander` secret-store tests, JCA2 storage/auth suites, and (optionally) a job/service setup for D-Bus + `gnome-keyring`/`secret-tool` to enable live Secret Service checks; explicitly mark unlocked-session dependency.
  - `macos-latest`: run mocked/keychain command-construction tests plus any non-interactive Keychain integration tests that can operate against the default login keychain in CI (may require keychain unlock/setup steps; feasibility must be validated per runner image/security policy).
  - `windows-latest`: run mocked/DPAPI PowerShell-path tests and encrypted fallback; native DPAPI store tests require Windows PowerShell and user-profile context (feasible in principle on runner, but must be explicitly implemented and validated).
- **Current automated platform verification status:** **Linux-only CI automation configured; macOS/Windows automated native credential verification not configured.**

### (c) Actual native verification
- **Linux Secret Service (observed, this host/session):** `node --test tests/jace-cli-auth-v2/e2e-cli-integration.test.mjs` passed (exit 0) in W5 worktree and included: `Linux Secret Service (secret-tool) live store/lookup/clear round-trip` and `E2E: jace auth device login, status, devices, revoke, logout with live Linux SecretServiceStore`. Artifacts: `verification/jca2-release-closure/worker5/e2e-cli-integration.stdout.log`, `.stderr.log`, `.exitcode`.
  - This demonstrates **actual native verification on a Linux host with an available/unlocked Secret Service** for the exercised paths. It is **not** proof of CI runner behavior without equivalent session setup.
- **macOS Keychain:** **Not verified natively** in this environment (Linux host). Mocked command behavior exists in tests; native `security` integration requires macOS hardware/runner with accessible keychain.
- **Windows DPAPI/Credential store:** **Not verified natively** in this environment. Mocked PowerShell/DPAPI path behavior exists in tests; native verification requires Windows with PowerShell and DPAPI user context.
- **Encrypted-file fallback:** Exercised by mocked/unit and JCA2 storage tests (Vitest) on Linux in this environment; see targeted/clean-clone results for pass/fail details (including SEC-31/SEC-32 observations). This is platform-agnostic logic but still environment-dependent for keyring/passphrase/runtime behavior.

## Proposed concrete matrix (assessment/recommendation; implementation not performed)

| Dimension | ubuntu-latest | macos-latest | windows-latest | Verification type | Notes |
|---|---|---|---|---|---|
| `secret-store` mocked unit tests (`node --test apps/jace-commander/test/secret-store.test.mjs` or via jc-native) | Yes | Yes | Yes | Mocked / logic | Validate command construction and stdin handling across platforms where Node tests run. |
| EncryptedFileStore + key material separation/perms/symlink rejection | Yes | Yes (POSIX perms semantics apply) | Partial/conditional | Automated logic with platform caveats | Windows file mode semantics differ; add Windows-specific assertions or document expected behavior. |
| Live Linux Secret Service (`secret-tool` + unlocked D-Bus session) | Conditional | N/A | N/A | Actual native (when available) | Requires runner/session provisioning; otherwise skip with explicit reason and do not count as native pass. |
| Live macOS Keychain (`security`) | N/A | Conditional | N/A | Actual native (requires accessible keychain) | Needs CI keychain setup/unlock; may be flaky/restricted on hosted runners. |
| Live Windows DPAPI (`powershell.exe`, CurrentUser) | N/A | N/A | Conditional | Actual native (requires Windows user context) | Validate path/profile permissions and non-interactive PowerShell execution. |
| JCA2 CLI/auth storage+redaction E2E (`tests/jace-cli-auth-v2/*`, `e2e-cli-integration.test.mjs`) | Yes (targeted) | Targeted/conditional | Targeted/conditional | Mixed (logic + environment-dependent native on Linux) | Separate Linux-native Secret Service steps from headless fallback assertions in CI reporting. |

## Risks/gaps identified

- No CI matrix means macOS/Windows credential backends are unverified automatically on each change.
- Linux native Secret Service verification depends on unlocked D-Bus session availability; CI may only cover mocked/fallback paths unless explicitly provisioned.
- Current Vitest include globs exclude `tests/jace-cli-auth-v2/e2e-cli-integration.test.mjs` (node:test), so it is not covered by `npm run test:vitest` despite being a critical auth/credential E2E.
- Platform-specific failure modes (keychain lock state, PowerShell policy, DPAPI profile issues) remain unexercised.

## Coordination note

- W6 worktree was reviewed read-only; no conflicting JCA2 credential-matrix evidence artifact was found. If W6 later publishes platform-credential verification under a different path, reconcile this assessment against it before release closure.
