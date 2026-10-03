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

The same admin policy applies to Desktop Commander and every approval-gated
Jace Commander mutation, including `privileged_exec`: ACS records an
`acs:admin` approval, then continues through the normal lease, capability,
containment, and audit path. Policy denials and invalid authority still fail
closed.

Consumers:

- `acs mode status|strict` reads or reduces authority in the same row (`ACS_DB_PATH`).
  `acs mode admin` refuses activation: local database access is not authenticated human approval.
- Mission Control shows the mode on the primary header and posts to `POST /execution-mode`.
- `GET /authority` and `GET /execution-mode` report that row plus the live lease observation.

Do not set a second mode in an environment variable. `ACS_MODE` is not consulted.

`POST /execution-mode` requires a configured `user` identity with the `operator`
role and `acs:approve` scope. Enabling `admin` additionally requires the
`acs:execution-mode:admin` scope and a `reason` of at least 8 characters;
`acs:approve` alone approves individual actions and cannot relax authorization
globally. Returning to `strict` needs only the human-operator gate. The legacy
single gateway token carries the admin scope only when its configured actor is
`user`.

Admin mode is time-boxed. It lapses to `strict` after `ACS_ADMIN_MODE_TTL_MS`
(default 3600000 = 1 hour; accepted range 60000 to 86400000). Every reader sees
the effective mode, so an expired row reads as `strict` immediately; the gateway
also persists the lapse as an `acs:admin-expiry` `execution_mode.changed` audit
event. `GET /execution-mode` reports `expiresAt` while admin is in effect.
Re-enabling restarts the clock. Mission Control asks for the reason in a
confirmation dialog before it sends the request. Service, worker, mixed-role, and agent identities
cannot change mode even when they hold that scope. Request-body identity fields
do not confer authority. This restricts the legacy global mode; it does not yet
implement mission-scoped Autonomous Authority Grants or make global admin mode
the target autonomy contract. Processes that can directly modify the database
remain within its trusted administrative boundary.
