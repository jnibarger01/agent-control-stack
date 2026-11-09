# ACS-managed native computer use (X11 pilot)

Status: **opt-in / isolated-desktop pilot; no production host-desktop certification**.

## Purpose

This integration provides the narrow mouse/keyboard/screenshot execution surface that
Anthropic's [computer-use-demo](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo)
illustrates, using ACS's existing `acs.jc.v1` authority lane. This is **not**
a vendor of Anthropic's example, nor a port of its Claude sampling loop, unrestricted
bash tool, browser profile, Streamlit app, or container deployment.

```text
Model/agent (untrusted screenshot interpretation and action proposal)
      |
OAuth /jc/mcp with trusted caller identity
      |
ACS /jc/capability/issue  --> durable work item, policy, exact human approval
      |                        + lease, signed per-call acs.jc.v1 capability
      v
Jace Commander (managed) --> verifier, current-authority check, trace intent
      |
Explicitly configured X11 DISPLAY --> fixed xdotool/import argv (no shell)
```

## Tools and trust

| MCP tool         | Scope         | Approval                                 | Behavior                                          |
| ---------------- | ------------- | ---------------------------------------- | ------------------------------------------------- |
| `gui_screenshot` | `gui.observe` | ACS-managed read                         | Capture bounded PNG of the configured X11 display |
| `gui_action`     | `gui.input`   | Human approval for each exact invocation | Click, move, drag, type, key, scroll              |

Calls to either tool are **refused** in Jace Commander standalone and local
presets. `gui_action` never accepts `acs:admin` auto-approval, even when
the canonical ACS execution mode is `admin`. The policy gate and issuance-table
constraint enforce this independently. Self-approval is prohibited.

ACS validates a strict schema, signs exact action arguments, binds them to its
existing work item, attempt, lease, invocation hash, runtime identity, and short-lived
single-use nonce. The Jace Commander verifier rechecks the capability and current
ACS authority before invoking the backend. No new signing key or unsecured route
is introduced.

## Activation

Native GUI control is **off** unless Jace Commander is explicitly launched with:

- `JC_GUI_ENABLED=1`
- `JC_GUI_DISPLAY=:81` (or another explicitly selected `:<display>` X11 server)
- `JC_GUI_XAUTHORITY=/path/to/isolated/xauthority` if the server requires a cookie

Use a dedicated unprivileged X11 session or container with dedicated user identity,
no host home bind mount, no SSH agent, no browser account profiles, and no ambient
credentials. The display and Xauthority values are operator-controlled configuration,
not MCP parameters. Launching an agent against your live `:0` display is **not**
recommended and is not a supported deployment claim.

The pilot calls fixed `/usr/bin/xdotool` and `/usr/bin/import` binaries via
`execFile` (never a shell), with an intentionally minimal environment. It requires
those executables to be installed in the isolated session. It does not support
Wayland compositor input or screenshot protocols. Those require a separate
authorization design and compositor-specific adapter.

Screenshots are bounded to 4 MiB and 8192×8192 pixels. Coordinates are nonnegative
integers <=8191. Text input is limited to 2048 UTF-16 code units; action kind and
fields are validated again locally. A failed backend call is denied and never
silently falls back to shell execution. Screenshots can expose private desktop
content: use an isolated desktop with no secrets and treat screenshot results as
untrusted observation, not instructions.

## Agent integration

A model client may use the MCP tools to observe the desktop and propose exact
actions. It must request a fresh ACS capability for every call. Do not reuse
Anthropic's demo's direct bash/computer executors as a parallel execution path.
Do not forward prompts, webpage contents, or visual instructions into ACS as
trusted authorization metadata. The existing browser-only CUA executor is a
separate lane and remains unchanged.

GUI approvals authorize **only the exact input event**, not the semantic result of
a click. Apps may change between screenshot and click, and an approval is not proof
that the target UI is safe. Use operator confirmation for external writes, purchases,
credentials, destructive operations, or changes to machine security. ACS has no
OS-enforced guarantee about the downstream result of a GUI event.

## Acceptance evidence / limitations

- `npm run build`: TypeScript and bundled runtime compilation.
- `npm run jc-contracts:check`: generated contract parity.
- `npx vitest run packages/jc-tool-manifest/src/gui-manifest.test.ts packages/policy-gate/src/gui-policy.test.ts tests/e2e/jc-tool-contract-drift.test.ts`: schema, human approval and cross-layer drift.
- `node apps/jace-commander/test/gui-backend.test.mjs`: no-shell argv, explicit opt-in, bounds, screenshot validation, and backend errors.
- CI `npm run check` and additional protected checks must pass before merge.

This change does **not** assert that visual automation works on a live CachyOS
Wayland session, nor does it implement Docker/VNC provisioners, Claude API model
sampling, UI semantic classification, or fully isolated production deployment.
Those require separate integration and end-to-end tests.
