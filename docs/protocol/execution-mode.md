# Execution mode

ACS has one canonical execution-policy state, stored as the single
`execution_mode_state` row in the control-plane database.

| Mode               | Approval policy | Path                                                                     |
| ------------------ | --------------- | ------------------------------------------------------------------------ |
| `strict` (default) | `policy`        | request → policy → human approval when required → capability → execution |
| `admin`            | `auto`          | request → policy → ACS records the approval → capability → execution     |

Admin mode is not break-glass. Break-glass runs outside ACS. Admin mode still
requires a healthy managed authority: authentication, one unambiguous executor
lease, no break-glass marker, and the managed runtime. Policy denials stay
denials. A missing or corrupt mode row fails closed.

The same admin policy applies to Desktop Commander and ordinary approval-gated
Jace Commander mutations: ACS records an `acs:admin` approval, then continues
through the normal lease, capability, and audit path. Jace Commander
`privileged_exec` remains human-only even in admin mode.

Changing the global mode is a privileged operator action. `POST /execution-mode`
requires an authenticated credential mapped to actor `user`, with the
`operator` role and `acs:approve` scope. Agent, worker, service, and write-only
credentials cannot enable admin mode. This protects the current global-mode
boundary from agent self-escalation; it does not make admin mode mission-scoped.
Mission-scoped autonomous authority grants are a separate architecture
requirement and must replace global admin before ACS can claim bounded,
pre-authorized autonomous execution.

Consumers:

- `acs mode status|strict` reads the row or restores strict mode locally. The CLI
  intentionally cannot enable admin because it has no authenticated principal.
- Mission Control shows the mode on the primary header and posts to `POST /execution-mode`.
- `GET /authority` and `GET /execution-mode` report that row plus the live lease observation.

Do not set a second mode in an environment variable. `ACS_MODE` is not consulted.
