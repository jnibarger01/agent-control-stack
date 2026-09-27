> Historical record written while this code lived in the Desktop Commander
> fork (`src/control-plane`). Source paths were updated to `apps/dc-relay/src`;
> repository-level commands and line references describe that repository.

# Jace control-plane architecture and protocol evidence

Baseline: `19a130818a83c99458de899cbf63b450ac1d9bbc` (verified at inspection time)
Scope: repository-only evidence; no hosted control-plane source is present in this checkout.

## Executive decision

FACT: This repository is a Desktop Commander local MCP server plus an optional remote-device connector. `package.json:2-24` identifies the package and its local MCP `dist/index.js` entrypoint; `src/index.ts:39-45` selects the remote-device mode only when explicitly invoked with `remote --standalone`.

RECOMMENDATION: Keep the hosted control plane as a separate deployable application/service. Keep this repository responsible for the local MCP runtime and the device connector/client protocol. A control-plane implementation here would mix a user-local stdio server, a device-side privileged bridge, and a public web/API/realtime service with different release, trust, scaling, and secret-management boundaries.

INFERENCE: The hosted service must own device authorization endpoints, Supabase schema/RLS, dispatch selection, result polling/doorbells, and remote-client MCP exposure. This is inferred from the connector's network edges; the hosted implementation is not included and cannot be verified here.

UNKNOWN: The exact hosted deployment repository, API implementation, SQL migrations, RLS policies, server constants, and remote-client connector implementation are not in this checkout. The report therefore freezes only the connector-observable v1 contract and marks server obligations as such.

## Component and dependency boundary

```text
Remote AI / connector (hosted) --MCP/API--> hosted control plane
                                            |-- Supabase Auth
                                            |-- Supabase Realtime private channel
                                            |-- Supabase PostgREST tables
                                            `-- dispatch/result recovery logic

local device process (this repo)
  `-- DesktopCommanderIntegration --stdio MCP--> local Desktop Commander child
  `-- HTTPS device auth/config ----------------> hosted control plane
  `-- Supabase Auth + Realtime/PostgREST ------> hosted Supabase project
```

FACT: `DesktopCommanderIntegration` resolves a local built child at `src/remote-device/desktop-commander-integration.ts:98-115`, or a global `desktop-commander --standalone` command at `:121-144`; it starts an MCP stdio client with `DC_REMOTE_DEVICE=true` at `:53-61` and connects at `:75-85`.

FACT: The child exposes the standard local MCP tool surface. The integration enumerates it with `listTools()` at `src/remote-device/desktop-commander-integration.ts:178-195` and invokes a named tool with arguments and `_meta.remote=true` at `:154-175`. The local server receives and dispatches `CallToolRequest` at `src/server.ts:1418-1430`, and its tool switch is at `:1508-1757`.

FACT: The local server is not a hosted HTTP control plane. It constructs an MCP `Server` at `src/server.ts:114-127` and connects a filtered stdio transport from `src/index.ts:60-65,153`; no HTTP listener or control-plane route is present in the tracked `src` tree.

## Hosted endpoint and request inventory

The connector's direct HTTPS requests are:

1. `GET https://mcp.desktopcommander.app/api/mcp-info` (default base URL) at `src/remote-device/device.ts:62-64,339-356`. It is unauthenticated (`:340`) and returns `supabaseUrl` plus `supabasePublishableKey` (the latter mapped to `anonKey` at `:351-356`). `MCP_SERVER_URL` can replace the base URL (`:63`).
2. `POST {base}/device/start` at `src/remote-device/device-authenticator.ts:66-93`, JSON body: `client_id`, `scope`, hostname, `device_type`, optional prior `device_id`, PKCE S256 challenge. No Authorization header is sent (`:69-80`).
3. `POST {base}/device/poll` at `src/remote-device/device-authenticator.ts:112-175`, JSON body: `device_code`, `client_id`, `code_verifier`; successful response must contain access and optional refresh tokens plus optional `device_id` (`:124-143`). Poll errors recognized are `authorization_pending` and `slow_down` (`:147-161`).

FACT: The verification URL is server-provided (`verification_uri` and `verification_uri_complete`) and opened/displayed by the device at `device-authenticator.ts:12-18,95-110`; the README's `test.acidpictures.org` URL is documentation/example only (`README.md:120-130`), not the runtime endpoint.

FACT: After configuration and authentication, all database/realtime calls use the Supabase client initialized with the returned URL/key at `src/remote-device/remote-channel.ts:216-249`. The code does not reveal the concrete Supabase project URL or schema policies.

## Authentication and persisted session lifecycle

FACT: Startup initializes the local child first, fetches Supabase config, loads persisted device/session state, restores the session if available, otherwise runs device authorization, sets the session, saves current tokens, then registers the device (`device.ts:167-250`).

FACT: Persistence defaults on (`device.ts:86-92`), stores at `~/.desktop-commander-device/device.json` (`:86`), and writes only `deviceId` and access/refresh tokens with mode `0600` (`:313-330`). The file is ignored by `src/remote-device/.gitignore:1-2`.

FACT: `setSession()` calls Supabase Auth `setSession`, then `getUser`, updates the current realtime auth token, caches tokens, and installs one auth listener (`remote-channel.ts:251-310`). `TOKEN_REFRESHED` re-authorizes realtime (`:294-303`). Manual refresh is disabled in the SDK and driven every 45 minutes (`:216-224,1281-1302`).

FACT: On `SIGNED_OUT`, the connector makes one forced refresh attempt using cached refresh credentials; on failure it tears down realtime, marks the device offline, and stops retrying until restart (`remote-channel.ts:313-401`).

RISK: The device file contains bearer credentials. The current boundary requires local filesystem protection, redaction in diagnostics, and no hosted API that returns refresh tokens after initial polling. Token rotation/revocation and logout semantics remain UNKNOWN server-side.

## Supabase tables and operations

The connector references exactly two application tables:

`mcp_devices`

- `findDevice`: select `id, device_name`, constrained by `id` and current `user_id` (`remote-channel.ts:409-423`).
- Registration update: replace `capabilities` and `device_name` before joining (`:472-480`).
- Create path exists but is not used by current registration: insert `user_id`, `device_name`, `capabilities`, `status`, `last_seen` (`:40-47,443-457`).
- Capability advertisement updates the complete JSONB `capabilities` value (`:562-589`): always `app_version`; after proven presence, `transport_broadcast_v1: true`.
- Heartbeat/status updates write `status` and `last_seen`, fenced with `.lte('last_seen', timestamp)` (`:1219-1263,1339-1364`). Shutdown uses a blocking subprocess to write `offline` with the same fence (`scripts/blocking-offline-update.js:44-57`).

`mcp_remote_calls`

- Doorbell handling fetches the row by `id` with `select('*').maybeSingle()` and retries twice (`remote-channel.ts:704-762`).
- Claim is a conditional update `status: executing` where current status is `pending`, with `select('id')` to observe whether this process won (`:1063-1093`).
- Result is an update by `id` with terminal status, `completed_at`, optional JSONB `result`, and optional text `error_message` (`:1095-1147`). NUL bytes are stripped before persistence (`:1102-1111`).

UNKNOWN: Column types beyond observed fields, primary/foreign key definitions, RLS predicates, indexes, delete/retention policy, who inserts remote-call rows, and who reads terminal rows are not present in this repository.

## Realtime channel contract

FACT: The connector creates a private per-user channel named `user:{user.id}` at `remote-channel.ts:603-625`. Presence is enabled with key exactly equal to `deviceId`; broadcast acknowledgement is enabled (`ack: true`).

FACT: Presence payload, tracked after successful subscription, is:
`{ device_id, device_name, app_version, platform }` (`remote-channel.ts:519-543`). A successful presence track is the proof required before writing `transport_broadcast_v1` (`:539-555`).

FACT: Broadcast event names and payloads are:

- `new_call`, received at `remote-channel.ts:627-635`; payload must include `call_id` and may include `device_id` (`:704-715`). It is a doorbell only: the receiver fetches the authoritative `mcp_remote_calls` row by ID.
- `result`, sent at `remote-channel.ts:770-787`; payload is `{ call_id }`. It is a result doorbell after the result row has been written. A failed/unacknowledged send is recoverable by server polling.

FACT: There is no active `postgres_changes` subscription in this baseline; the current path is Realtime Broadcast plus Presence. This is corroborated by the channel setup (`:627-635`) and the transport tests' stated scope (`test/test-remote-transport.js:1-15`).

FACT: The server-side liveness contract copied into tests is 45 seconds for unflagged/withdrawn devices and 15 minutes for broadcast-capable devices (`test/test-remote-transport.js:21-25,315-341`). The device heartbeat is 15 seconds in the unproven/withdrawn tier and 5 minutes in the capable tier (`remote-channel.ts:48-52,1209-1217`). The copied thresholds are a drift risk because no cross-repository enforcement exists (`test/test-remote-transport.js:21-23`).

## Call, claim, result, and failure semantics

FACT: Device routing rejects a row whose `device_id` differs from this device (`device.ts:371-382`). It remembers up to 100 handled call IDs (`:361-369`) and suppresses duplicate delivery before any execution (`:386-407`).

FACT: The authoritative execution sequence is: local bounded dedupe, conditional DB claim, local tool execution, terminal result update, then result broadcast (`device.ts:386-443`). The result write must precede the `result` doorbell because the hosted reader fetches the row by ID; this ordering is explicitly tested (`test/test-remote-transport.js:301-313`).

FACT: A successful call writes `completed`; an exception writes `failed` with an error message and still sends the result doorbell (`device.ts:445-457`). If a result write fails, the connector attempts a text-only terminal `failed` fallback (`remote-channel.ts:1122-1143`).

INFERENCE: The hosted dispatcher should treat `pending -> executing` as a single-winner transition and should never execute a non-pending row. The connector's transient DB-error behavior currently fails open (`remote-channel.ts:1064-1084`), so exactly-once is only guaranteed within one process by the local dedupe set; cross-process exactly-once is NOT guaranteed on a claim write error.

UNKNOWN: Hosted timeout/retry policy, whether executing rows are reclaimed, maximum result size, caller authorization, and whether result broadcasts are authenticated/filtered beyond private-channel membership.

## Frozen v1 connector-observable contract recommendation

Freeze these decisions before implementing a hosted control plane:

1. Base URL is configurable, default `https://mcp.desktopcommander.app`; required endpoints are `GET /api/mcp-info`, `POST /device/start`, and `POST /device/poll`.
2. Device authorization uses OAuth 2.0 Device Authorization semantics with PKCE S256, `client_id=mcp-device`, scope `mcp:tools`; poll must preserve `authorization_pending` and `slow_down` semantics.
3. Supabase access is user-session based. Device joins only private channel `user:{user_id}` with Presence key `device_id`; server must enforce user/device ownership through Auth/RLS.
4. `mcp_devices` is the device registry; `mcp_remote_calls` is the durable call/result row. Required observed fields are the ones listed above; hosted schema may add fields but must not change these meanings in v1.
5. `new_call` carries `{call_id, device_id?}` and is never the authoritative call body. `result` carries `{call_id}` and is only a wake-up signal. Both paths require row reads and tolerate lost doorbells via polling.
6. Claim semantics are conditional `pending -> executing`; terminal states are `completed` or `failed`, with `completed_at`. Result persistence precedes result notification.
7. Broadcast capability is advertised only after Presence `track()` acknowledges; absent Presence is authoritative offline for capable devices. Capability withdrawal must restore the fast heartbeat tier.
8. Status/liveness writes are monotonic/fenced by `last_seen`; clean shutdown attempts a durable offline write, but the hosted sweep remains the crash fallback.
9. The hosted service owns remote-client MCP exposure and dispatch policy; this repository owns local execution and must not receive hosted service secrets.

## Risks and open decisions

- HIGH: Split-repository contract drift. Server thresholds are hand-copied in tests (`test/test-remote-transport.js:21-25`); generate a shared schema/constants package or contract tests before changing either side.
- HIGH: Fail-open claim errors can duplicate side effects across processes (`remote-channel.ts:1064-1084`). v1 should prefer fail-closed claim behavior or an explicit idempotency key/lease protocol before claiming cross-process exactly-once.
- HIGH: Device bearer tokens are persisted locally (`device.ts:313-330`). Define revocation, rotation, logout, and recovery behavior in the hosted auth contract.
- MEDIUM: A private channel is per user, while device routing is payload/row based (`remote-channel.ts:613-635,704-762`). Enforce ownership and device targeting in server writes/RLS; do not rely on the payload filter alone.
- MEDIUM: Result and call rows can contain large JSON payloads; connector comments note results up to 13 MB (`remote-channel.ts:1113-1120`). Define maximum size, compression/object-storage strategy, and terminal-row retention.
- MEDIUM: Realtime reconnect exhaustion shuts down the local child after eight attempts by default (`remote-channel.ts:71-76,1012-1060`; `device.ts:64-81`). Hosted availability and local service-manager restart policy must be compatible.
- UNKNOWN: Whether the deployed service currently honors the documented `transport_broadcast_v1` flag, the exact sweep implementation, and the remote caller's authorization model.

## Verification record

FACT: Read-only inspection commands executed successfully:

- `git status --short && git rev-parse HEAD && git branch --show-current` — exit 0; baseline `19a130818a83c99458de899cbf63b450ac1d9bbc`, branch `feat/jace-remote-control-plane`, no pre-existing status output.
- `git log --oneline --decorate -12` — exit 0; HEAD is merge `19a1308`, with prior runtime merge `4784343` and durable-session docs `1059964`.
- `git ls-tree -r --name-only HEAD src` (directory inventory) — exit 0; tracked source includes `src/remote-device`, but no `supabase`, `migrations`, or hosted control-plane application directory.
- Repository searches for hosted URLs, endpoint paths, table names, broadcast events, and presence configuration — exit 0; all observed matches are documented above.

The only write made for this task is this report under `docs/architecture/`; no source, dependency, remote, or production state was changed.
