# ACS master startup controller

Use the controller on Linux hosts that already run these four units in the same systemd user manager.

| Unit                                | Role                       | Default operator probe    |
| ----------------------------------- | -------------------------- | ------------------------- |
| `acs-recovery.service`              | ACS gateway                | `127.0.0.1:3000/readyz`   |
| `acs-computer-use-xvfb.service`     | Isolated X display         | Unit state, optional X11  |
| `jace-commander-mcp.service`        | Jace Commander MCP bridge  | `127.0.0.1:8003/healthz`  |
| `jace-commander-auth-proxy.service` | Jace Commander OAuth proxy | `127.0.0.1:8010/jc/ready` |

The existing proxy unit must declare ordering after the gateway and MCP bridge. The target uses `Wants=` to
start all four during user-manager startup. Each service keeps its own process, restart policy, authentication,
and isolation. CUE, Hermes, and OpenClaw are outside the controller's scope.

## Install or migrate startup

Run from the repository root as the service account, with its user systemd manager available. The installer
uses Bash, systemd, GNU coreutils, and util-linux `flock`. The operator CLI also uses `curl`, and uses
`xdpyinfo` when an X display probe is configured.

```bash
deploy/systemd/acs-stack/install.sh install
systemctl --user is-enabled acs-stack.target
systemctl --user list-dependencies acs-stack.target
```

The installer writes the target under `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user` and the command to
`$HOME/.local/bin/acs-stack`. Use the absolute command path or include `$HOME/.local/bin` in `PATH`.
Installation refuses an existing unmanaged target or command. Repeating the same installation checks the
existing configuration. To replace an installed version, uninstall it first using the receipt.

Before switching startup ownership, the installer creates a private receipt at
`${XDG_STATE_HOME:-$HOME/.local/state}/acs-stack`, validates the target, and reloads systemd. It removes
only the four units' direct links under `default.target.wants`. The receipt keeps the exact prior links,
including which links were absent. Existing definitions, drop-ins, and links under other targets are
preserved. Installation only changes startup enablement. It can be performed while the services are running
and takes effect at the next user-manager start. To activate the target in the current session, run
`acs-stack start` after checking the existing service state.

## Operate the stack

```bash
acs-stack start
acs-stack status
acs-stack logs
acs-stack logs --follow
acs-stack stop
acs-stack restart
```

`start` starts and checks the gateway, Xvfb, and MCP bridge before the proxy. It uses systemd start jobs
so active units keep running. `stop` checks for existing stop propagation to unmanaged units before
stopping the proxy, MCP bridge, Xvfb, and gateway in that order. It then stops the target.
`systemctl --user stop acs-stack.target` stops only the target. `restart` runs the same ordered stop and start,
reports failed jobs or probes, and may interrupt traffic. `status` displays unit state, enablement, PIDs,
restart counts, warnings, and health. It exits nonzero if the target is inactive or a service check fails.

Override probes per invocation with `ACS_STACK_GATEWAY_URL`, `ACS_STACK_MCP_URL`, and `ACS_STACK_PROXY_URL`.
Use unauthenticated loopback HTTP paths at `127.0.0.1` or `[::1]`. The probe accepts a plain path.
For an X11 query, set `ACS_STACK_X_DISPLAY` to the configured local display and
`ACS_STACK_X_AUTHORITY` to the path of the existing authority file, if needed. Without a configured display,
the Xvfb check reports systemd service activity.

## Uninstall or recover a failed installation

Run with the same account and XDG paths used for installation.

```bash
deploy/systemd/acs-stack/install.sh uninstall
systemctl --user list-dependencies default.target
```

Uninstall restores the saved direct links, removes the controller's target, link, and command, and reloads
the user manager. It leaves running processes alone. Installation errors trigger the same recovery
automatically. If a reload fails or the process is interrupted, keep the receipt and retry uninstall.
The script refuses to overwrite an altered link or remove an edited controller file. Inspect the reported
path and preserve any operator edits before retrying. A controller installed manually requires manual
rollback using the backup from that installation.
