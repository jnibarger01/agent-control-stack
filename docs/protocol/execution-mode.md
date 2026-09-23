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

Consumers:

- `acs mode status|strict|admin` reads and writes the same row (`ACS_DB_PATH`).
- Mission Control shows the mode on the primary header and posts to `POST /execution-mode`.
- `GET /authority` and `GET /execution-mode` report that row plus the live lease observation.

Do not set a second mode in an environment variable. `ACS_MODE` is not consulted.
