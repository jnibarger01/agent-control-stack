# Runtime configuration

All ACS processes use the versioned schema exported by `@agent-control-stack/shared` and loaded once at startup with `loadRuntimeConfig()`. The current schema version is `1`.

| Setting                      | Environment variable                                           | Default              | Secret |
| ---------------------------- | -------------------------------------------------------------- | -------------------- | ------ |
| Environment                  | `NODE_ENV`                                                     | `development`        | No     |
| Gateway host / port          | `HOST` / `PORT`                                                | `127.0.0.1` / `3000` | No     |
| Database                     | `ACS_DB_PATH`                                                  | `storage/local.db`   | No     |
| Auth mode                    | `ACS_AUTH_MODE`                                                | inferred             | No     |
| Gateway bearer               | `ACS_GATEWAY_TOKEN`                                            | unset                | Yes    |
| OAuth issuer, audience, JWKS | `ACS_OAUTH_ISSUER`, `ACS_OAUTH_AUDIENCE`, `ACS_OAUTH_JWKS_URI` | unset                | No     |
| Trusted tunnel proxy         | `ACS_TRUSTED_TUNNEL_PROXY`                                     | unset                | No     |
| Schedule file                | `ACS_SCHEDULE_CONFIG_PATH`                                     | unset                | No     |
| Machine controller file      | `ACS_MACHINE_CONTROLLER_CONFIG`                                | unset                | No     |
| Sandbox integration tests    | `ACS_SANDBOX_INTEGRATION`                                      | `false`              | No     |

The loader rejects malformed values, incomplete OAuth settings, mismatched auth-mode fields, remote production binding without authentication, and local bearer authentication in production. Unknown `ACS_*` settings are tolerated in development for migration but rejected in production. `ACS_CONFIG_VERSION=1` can be set explicitly; other versions fail closed.

The legacy unprefixed `HOST` and `PORT` variables remain an explicit compatibility alias for one release. Diagnostics should use `redactRuntimeConfig`; bearer values are always rendered as `[REDACTED]`.
