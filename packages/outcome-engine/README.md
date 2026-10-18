# @agent-control-stack/outcome-engine

Read-only verified assessment of pull request readiness. See [docs/outcome-engine.md](../../docs/outcome-engine.md) and [ADR 0028](../../docs/adr/0028-outcome-engine-verdict-records.md).

**Reads:** one pull request through an injected `PullRequestReader` (twice per evaluation), and the ACS audit chain.
**Writes:** `outcome.accepted` and `outcome.evaluation_recorded` audit events, through a three-method `OutcomeStorePort`.
**Refuses:** any execution, merge, deploy, push, comment, label, review or approval path; any caller-supplied verdict, status, grade, actor or authority field; any evidence that is not trusted and live.

`computeVerdict` (`src/verdict.ts`) is the only producer of a verdict. A verdict is evidence, never authority. `outcome.*` records are tamper-evident only.
