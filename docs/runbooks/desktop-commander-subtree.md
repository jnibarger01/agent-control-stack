# Desktop Commander subtree (`vendor/desktop-commander`)

Desktop Commander is vendored as a **git subtree** (ADR 0019), not a submodule
and not an npm workspace. It keeps its own `package.json`, lockfile, build, and
test suite, so it can keep following upstream.

| Item                   | Value                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Prefix                 | `vendor/desktop-commander`                                                                                   |
| Imported from          | `jnibarger01/desktop-commander` `main` @ `99913e6931c89211a4fe1849b9ab20e5567cbdc4`                          |
| Last subtree pull      | `jnibarger01/desktop-commander` `main` @ `a80865d` (PR #13); gateway `main` @ `72a9b06` (PRs #2, #4)         |
| Import commit (ACS)    | `import(desktop-commander): add desktop-commander@99913e6 as a git subtree with full history`                |
| Upstream of the fork   | `wonderwhy-er/DesktopCommanderMCP`                                                                           |
| Fork-only code removed | `src/control-plane` (now `apps/dc-relay`), relay tests, relay Supabase migrations, `control-plane:*` scripts |

## Build and test it

```sh
cd vendor/desktop-commander
npm ci                       # needs GITHUB_TOKEN in CI: @vscode/ripgrep's postinstall calls api.github.com
npm run validate:tools
npm test                     # builds first
npm run test:integration
```

CI runs exactly this in `.github/workflows/dc-execution-chain.yml`
(`desktop-commander` job), plus the root E2E tests against the built `dist/`.

## Pull upstream Desktop Commander changes

Always work on a branch and open a PR; never pull into `main` directly.

```sh
git remote add dc-upstream https://github.com/wonderwhy-er/DesktopCommanderMCP.git   # once
git fetch dc-upstream main
git subtree pull --prefix=vendor/desktop-commander dc-upstream main   # no --squash: keep history
```

Then, before opening the PR:

1. Resolve conflicts. Fork-only enforcement code (`src/managed-acs*.ts`,
   `src/enforcement/`, `src/security/`, `src/executor-lock.ts`, the
   `handleCallToolRequest` gate in `src/server.ts`, `src/remote-device/`) wins
   unless the upstream change is reviewed line by line. Never drop the managed
   guard or the kernel to take an upstream change.
2. If upstream added or renamed a tool, give it a disposition in
   `packages/dc-tool-manifest/src/manifest.ts` (and, for a capability tool, an
   argument schema and ACS mechanics), mirror the disposition in
   `vendor/desktop-commander/src/managed-acs.ts`, then run
   `npm run dc-contracts:generate` and update the SHA-256 pins in
   `vendor/desktop-commander/test/test-managed-authorization-contract.js`.
3. Run the DC suite above, then from the root: `npm run check` and
   `ACS_DC_E2E=1 npx vitest run tests/e2e`.

The drift gate (`tests/e2e/dc-tool-contract-drift.test.ts`) and the
architecture gate (`tests/e2e/dc-enforcement-architecture.test.ts`) fail if an
upstream pull silently widens what Desktop Commander accepts or restructures
the call handler around the capability check.

## Reading the pre-import history

`git subtree add` merges the fork's history with its original paths, so
`git log --follow vendor/desktop-commander/...` stops at the import merge. Ask
for the path as it was before the import through the subtree parent instead:

```sh
IMPORT=$(git log --format=%H -1 --grep='add desktop-commander@99913e6')
git log "$IMPORT^2" -- src/managed-acs.ts          # Desktop Commander history
git log "$IMPORT^2" -- src/control-plane/server.ts # relay history before apps/dc-relay
```

The same applies to `apps/dc-mcp-gateway` (import commit
`import(dc-mcp-gateway): add desktop-commander-mcp-gateway@ee4a98e with full history`).

## Source repositories

`jnibarger01/desktop-commander` and `jnibarger01/desktop-commander-mcp-gateway`
stay live until this migration is merged and validated on the host. Changes
that land there in the meantime are brought over with `git subtree pull`
from those repositories, never re-typed by hand.
