# Claude Code plugin release report

Date: 2026-07-15

## Architecture

Agent Control Stack remains a Node/TypeScript application. Its Claude Code integration is a thin root-level plugin containing one review skill and one optional authenticated loopback MCP connection. It does not add commands, agents, hooks, LSP servers, background monitors, or executable plugin scripts.

The root plugin slug is `agent-control-stack`; its review skill is exposed as `/agent-control-stack:acs-review`. Version `0.1.0` is declared only in `.claude-plugin/plugin.json`. The separate `jace-private-plugins` marketplace intentionally omits a second version declaration.

## Official requirements checked

- Plugin creation and local `--plugin-dir` loading: <https://code.claude.com/docs/en/plugins>
- Plugin manifest, component paths, user configuration, and MCP substitution: <https://code.claude.com/docs/en/plugins-reference>
- Marketplace schema, GitHub sources, installation, update, and validation: <https://code.claude.com/docs/en/plugin-marketplaces>
- Anthropic-managed directory and third-party submission distinction: <https://github.com/anthropics/claude-plugins-official>

The current documentation permits `skills/` and `.mcp.json` at the plugin root, `userConfig` in the manifest, and `${user_config.KEY}` substitution in MCP configuration. A marketplace may reference a GitHub repository using `{ "source": "github", "repo": "owner/repo" }`. Official validation is `claude plugin validate <path>`.

Anthropic documents a reviewed `claude-community` submission form for third-party plugins. The separately curated `claude-plugins-official` marketplace has no public application process; Anthropic decides inclusion. A community submission therefore cannot be reported as an official-marketplace submission or acceptance.

## Validation evidence

Run from the isolated `feat/claude-plugin-marketplace` worktree based on `origin/main` at `d2cd2aa`:

- `npm ci`: exit 0; 118 packages added; npm reported zero known vulnerabilities.
- `npm run build`: exit 0 as part of `npm run check`.
- `env -u ACS_MCP_BEARER_TOKEN npm run check` outside the managed sandbox: exit 0; TypeScript build passed and all 281 tests in 34 files passed. The earlier five MCP failures were caused by the host bearer variable enabling authentication in tests that intentionally exercise an unconfigured local endpoint. The earlier eight ACP timeouts were caused by nested child-process restrictions in the managed sandbox.
- `claude plugin validate .`: exit 0 with one warning that root `CLAUDE.md` is project context and is not loaded as plugin context.
- Prepared marketplace `claude plugin validate .`: exit 0.
- `claude plugin marketplace add /home/jacen/claude-private-marketplace` and `claude plugin install agent-control-stack@jace-private-plugins --config mcp_bearer_token=...`: exit 0 after changing the source to the official HTTPS Git format; Claude Code fetched the published source branch, installed version 0.1.0, and preserved the `acs` MCP definition.
- Bounded non-interactive `/agent-control-stack:acs-review` invocation with Haiku: exit 0. With no repository evidence supplied, it returned `Verdict: BLOCK`, all required output sections, the unverified invariants, and the precise next action, matching the skill failure contract.

The tracked-file secret scan found variable names, placeholders, test fixtures, and redaction documentation. It found no tracked `.env`, private-key file, or confirmed credential. Real values must remain outside Git.

## Publication gates

- Source branch commit: `49daac6` plus the final evidence update.
- Source push: published to `origin/feat/claude-plugin-marketplace`; no merge or pull request was created.
- Marketplace repository: prepared locally at `/home/jacen/claude-private-marketplace`; the requested GitHub repository was not visible through the current account and could not be published.
- Anthropic community submission: not submitted. The plugin must first be published at a stable public source, pass its full release gate or document accepted exceptions, and complete the official review form.
- Anthropic official marketplace: not submitted or accepted; there is no public application process.
