# Anthropic plugin submission package

## Status

Prepared, not submitted.

Anthropic's current documentation separates two destinations:

- `claude-community` accepts reviewed third-party submissions through a form.
- `claude-plugins-official` is curated at Anthropic's discretion and has no public application process.

Submitting the form does not submit to or publish in `claude-plugins-official`.

## Community submission fields

- Plugin name: `agent-control-stack`
- Display name: Agent Control Stack
- Source repository: <https://github.com/jnibarger01/agent-control-stack>
- Release branch: `feat/claude-plugin-marketplace`
- Plugin path: repository root
- Version: `0.1.0`
- License: MIT
- Category: development
- Summary: Review Agent Control Stack changes for policy, exact-action approval, audit, authentication, MCP exposure, and execution-boundary defects, with an optional authenticated loopback MCP connection to a separately running ACS gateway.
- Network access: fixed loopback HTTP endpoint `http://127.0.0.1:3000/mcp`; no remote endpoint is bundled.
- Secrets: one required sensitive `mcp_bearer_token` plugin option; the value is sent only as the loopback MCP Authorization header.
- Executable behavior: no hooks, scripts, commands, agents, LSP servers, or bundled executables. The skill may request read-only Git and test commands subject to Claude Code permissions.
- Mutation capability: ACS MCP tools may create or transition work items when ACS authentication, actor binding, policy, and approval gates permit it. The plugin does not start ACS or bypass those gates.

## Checklist before submission

- [x] `claude plugin validate .` passes.
- [x] Marketplace validation passes.
- [x] Marketplace installation from the published source branch succeeds.
- [x] MIT license is present.
- [x] Security and permission behavior is documented.
- [x] Tracked-file secret scan found no confirmed credential or private key.
- [x] Full clean-branch build and test gate passes: 281/281 tests.
- [x] A live `/agent-control-stack:acs-review` invocation completes and follows its failure contract.
- [ ] Merge the release branch after independent review.
- [x] Pin the release to the full commit SHA recorded in the published marketplace entry.
- [x] Update the marketplace entry to that immutable release.
- [x] Publish `jnibarger01/claude-private-marketplace` privately and retest installation from GitHub.

## Manual submission action

After every unchecked gate is complete, submit through one of the official forms documented at <https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-community-marketplace>:

- Individual author: <https://platform.claude.com/plugins/submit>
- Team or Enterprise directory manager: <https://claude.ai/admin-settings/directory/submissions/plugins/new>

Report the result as `SUBMITTED` until review is approved and the plugin appears in the `claude-community` catalog. Report `claude-plugins-official` as not accepted unless Anthropic independently adds it.
