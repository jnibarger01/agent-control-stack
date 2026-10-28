# @agent-control-stack/workspace-manager

Provisions one git worktree per job under `rootDir` and records ownership in the work-item store.

## Worktree lock (Linux only; fails closed elsewhere)

Every `git worktree` command is serialized per repository with a kernel `flock(2)` on
`<git common dir>/acs-worktree.lock`, taken through util-linux `flock(1)`:

```
[setpriv --pdeathsig KILL] flock --exclusive --close --wait <lockWaitMs> --conflict-exit-code 75 <lock> \
  /bin/sh -c 'printf L >&3 || exit 70; exec 3>&-; exec "$@"' acs-worktree-lock [setpriv --pdeathsig KILL] git ...
```

- `--close`: only `flock(1)` holds the lock descriptor. git, its hooks, and anything they background or
  `setsid` never inherit it, so the lock is released as soon as `flock` exits.
- The inline `sh` writes one byte to fd 3 (a pipe to node) once the lock is held, then closes fd 3 and
  `exec`s git. Node uses that signal to bound the lock wait by `lockWaitMs` and then git by
  `gitTimeoutMs` separately. It also tells a real lock conflict (exit 75, never signalled) apart from git or
  a hook exiting 75 (signalled first).
- `setpriv --pdeathsig KILL` (util-linux, on Ubuntu and Debian bookworm images) makes the kernel SIGKILL
  `flock` if node dies, even by SIGKILL, and makes it SIGKILL git if `flock` dies. Without `setpriv` on
  PATH, the lock still works, but a SIGKILLed node can leave an orphaned `flock` holding the lock until
  its git finishes or is killed.
- On timeout, node SIGKILLs the whole process group.

**macOS and other hosts without util-linux `flock(1)`:** the lock fails closed. Every worktree command is
refused with `workspace_git_lock_unavailable` and nothing runs without the lock. Install util-linux
`flock` (for example `brew install util-linux` and put its `bin` on PATH, or set `flockPath`), or run the
workspace manager on Linux.
