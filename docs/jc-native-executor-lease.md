# Native Jace Commander executor lease

The canonical ACS executor slot is `<lockDir>/executor.lock`, where `lockDir` is
`DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR` or `~/.desktop-commander`. ACS
(`packages/policy-gate/src/managed-authority.ts`) reads this file and grants
managed authority only when the holder is a live, identity-verified managed
executor.

## Record format

The record is the Desktop Commander lease, unchanged, plus three additive v2
fields written only by the native Jace Commander executor:

| field | DC lease | JC lease (v2) |
| --- | --- | --- |
| `instanceId`, `pid`, `acquiredAt`, `renews`, `expiresAt`, `hostname` | yes | yes |
| `bootId`, `processStartTicks` | optional | required |
| `executorKind` | absent | `"jace-commander"` |
| `releaseRoot` | absent | release dir as the process spells it (the `current` symlink, not its realpath) |
| `releaseCommit` | absent | commit from the release's `RELEASE.json` |

A record with `executorKind` must name the same root that `/proc/<pid>/cmdline`
shows for the holder, or ACS fails closed. Legacy DC records keep their
original semantics and are never reinterpreted as JC.

## Recognition

ACS recognizes the installed JC runtime only at
`.../.local/lib/jace-commander/{current|releases/<id>}/dist/cli.js`. Vendored
copies under `node_modules` are rejected. The generic `dist/cli.js` name is not
widened to other ACS release roots.

## Lifecycle

- **Acquire** (`holdJcExecutorLease` / `acquireJcExecutorLease`, `apps/jace-commander/src/executor-lease.ts`):
  only in `managed` mode, before any tool is served. `serve` first calls
  `verifyJcReleaseIdentity` and refuses to start unless the entrypoint is an
  installed release: `<prefix>/{current|releases/<id>}/dist/cli.js`, where the
  root resolves to a real directory inside the real `<prefix>/releases`, its
  `dist/cli.js` resolves inside that directory, nothing is under `node_modules`,
  and `RELEASE.json` is a regular file whose `commit` is 7 to 40 lowercase hex
  digits. A development checkout, a `current` link pointed at a checkout, or a
  placeholder commit (`unknown`, `unreleased`) is refused with a named reason;
  there is no fallback identity. `acquireJcExecutorLease` also refuses
  (`release-unverified`) any lease whose commit is not a git commit id.
- **Renew**: every 60s while the process lives (the 10s figure is the dead-PID
  takeover grace). Losing the record is reported through `onLost`, and the
  process stops serving.
- **Release**: on `exit` and on SIGTERM/SIGINT/SIGHUP. A release never deletes a
  lease that another owner has since written.
- **Takeover**: a dead or identity-mismatched holder is taken over only after the
  grace window, under a takeover mutex. A malformed record is never taken over.

A held lease grants no permission to execute anything. ACS still authorizes
every GUI, filesystem, process, and privileged action.

## Topology

Desktop Commander and Jace Commander share one lock file by design, so there is
one canonical executor per lock directory. A second executor is refused while
the first is alive. To run both, give one a separate `DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR`.
