# Jace Commander native runtime

Jace Commander owns its MCP server, filesystem, terminal, process registry, credential scanner, document readers and capability verifier. It neither imports nor starts Desktop Commander. Shared ACS contracts are embedded by the canonical generator so the package also builds outside this monorepo.

## Build and verify

From the repository root:

- `npm test -w apps/jace-commander`
- `npm run jc-contracts:check`
- `npm run jc:verify-independence`

The independence verifier makes a physical copy under /tmp, installs only this package's declared dependencies, builds it, and runs its complete test suite without workspace files or a Desktop Commander tree. Standalone installation uses `npm install && npm test` inside this package. Node >=24.16 and /usr/bin/python3 are needed; the latter allocates POSIX PTYs with the standard library. Linux is the supported terminal platform.

## Managed execution

Use `node apps/jace-commander/dist/cli.js serve` behind the authenticated bridge. The bridge defaults to this native package; `JC_RUNTIME_DIR` can select another native build. `JC_DC_DIR` remains a deprecated directory alias but now expects the native dist/cli.js layout.

Every managed call needs an ACS Ed25519 capability with exact tool, arguments, runtime, scopes, expiry and single-use nonce bindings. Every managed non-read operation additionally reads the current work item and attempt lease from ACS before dispatch. Missing credentials, an outage, a revoked or expired lease, a changed fencing epoch, plan, approval or invocation, and a mismatched authenticated principal all refuse execution. The privileged helper independently verifies the capability again. JC never mints capabilities.

The bridge stamps authenticated gateway metadata. Process sessions belong to that subject and OAuth client; another principal cannot list, read, write stdin to, or kill them. Missing gateway identity refuses process tools. Direct stdio has one local transport owner.

Legacy local-policy and read-only standalone presets remain explicit compatibility modes. The managed bridge rejects either preset and rejects --standalone; neither is an outage fallback. This release does not enable or deploy either mode.

## New tools and compatibility

The 36 existing tool schemas retain their required fields and existing property types. Four approval-gated tools are added:

| Tool                   | Behavior                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- |
| run_command            | Shell command with contained cwd, bounded timeout and optional PTY; CLI: jc run  |
| start_terminal_session | Interactive PTY; each stdin call requires its own capability                     |
| interact_with_process  | Approved exact stdin text to an owned session; CLI: jc send                      |
| delete_file            | Contained unlink or recursive delete; root and .git deletion refused; CLI: jc rm |

write_file additionally accepts optional encoding=utf8 or base64. Base64 must be canonical. read_process_output accepts separate absolute byte cursors and waitMs, and returns nextStdoutOffset/nextStderrOffset plus retained-buffer starts. The legacy offset remains accepted and applies to both streams; consumers should migrate to byte cursors for streaming.

The default shell is /bin/bash. JC_SHELLS is a colon-separated administrator configuration of absolute shell paths. The caller cannot select any other shell. Caller environment overrides are restricted to LANG, LC_ALL, LC_CTYPE, TZ, TERM, COLORTERM, NO_COLOR and FORCE_COLOR. Parent credentials and signing keys are not forwarded.

## Security limits

A contained cwd is not an OS filesystem sandbox. An explicitly approved shell command runs with the JC account's operating-system privileges and can access that account's files. Environment filtering does not isolate a same-UID process from /proc or credential files. A separate executor identity or OS sandbox is required to enforce account-level credential isolation; it has not been configured by this change. PTY output merges stderr into stdout, as terminal devices do. Non-PTY calls retain separate streams.

The current-authority read is a pre-dispatch check, not a transaction spanning ACS and the operating system. Revocation does not retroactively undo an already started command. Process timeouts and server shutdown terminate the managed process group; tools do not claim containment against a hostile program deliberately escaping its process group.

Local JSONL traces record hashes and authority identifiers, not raw commands, stdin or environment values. ACS remains the canonical result and audit authority; bridge result submission preserves that path.

## Migration (prepared, not executed)

Do not change live services until review and explicit rollout approval.

1. Build and run the verification commands above; review migration 076 and check its number against current main and open PRs. 075 is already reserved by other work. 076 is a local candidate and has not been reserved by a draft PR.
2. Apply the additive ACS migration through the normal deployment procedure. Existing databases are not edited by these development tests.
3. Review the managed templates under apps/dc-mcp-gateway/deploy. The user unit uses %h/projects/agent-control-stack, /usr/bin/node, and %h/.config/acs/jc-bridge.env. Use EnvironmentFile directly; do not shell-source JSON credentials.
4. Privately configure matching ACS/JC filesystem roots, public verification key, key ID and runtime ID; JC_ACS_TOKEN needs read access to the authoritative work-item/lease route. Existing dedicated worker result credentials remain bridge-only.
5. With rollout approval, reload/restart the JC bridge and validate loopback :8003/authority plus the edge /jc/ready. The intended public URL is https://cachyos-x8664.tailaa6d41.ts.net/jc/mcp. No endpoint publication, live credentials, gateway :3000, Tailscale configuration or privileged helper installation was changed here.

An independent security review, real ACS-to-native-JC execution evidence, production credential-isolation design, migration reservation/preflight and the repository's full check remain release gates until separately verified.
