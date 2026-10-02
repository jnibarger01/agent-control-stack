# Autonomous coding missions

A coding mission prepares an immutable change set without a human approval prompt, then stops at one decision: approve that exact change set. Merge, deployment, and verification run only after that approval still matches the stored proposal.

Preparation uses the ACS Nimble router (`nimble.noul.highest-score.v1`). JEV does not select workers. Policy denials fail the mission. They are not turned into extra approval prompts, and there is no bypass flag.

The durable states are `PLANNING`, `RUNNING`, `RECONCILING`, `VALIDATING`, `PREPARING_CHANGE_SET`, `PUBLISHING_PROPOSAL`, `WAITING_FOR_APPROVAL`, `APPROVED`, `EXECUTING`, `VERIFYING`, `COMPLETED`, `FAILED`, and `DEGRADED`.

`WAITING_FOR_APPROVAL` is the only routine human boundary. The approval view shows the summary, repository, files, head commit, canonical pull request, validation checks, change-set hash, and deployment impact. Approving a different hash fails closed. An already-issued authority grant can cover that same hash; the controller does not mint grants.

One mission owns one branch, `acs/mission/<mission id>`, and one pull request. Unknown outcomes of publish, merge, or deploy stay unknown until observation. They are not retried blindly. Completion is a single effect and requires operation results, a merge SHA, verification evidence, and deployment evidence when the repository policy requires it.

HTTP surface:

- `POST /coding-missions` creates the mission and runs preparation until it is waiting, approved by a grant, or stopped.
- `GET /coding-missions` lists recent missions for Mission Control.
- `GET /coding-missions/:id` returns the approval view.
- `POST /coding-missions/:id/approve` records the human decision for the exact displayed change-set hash and continues execution in the same request.

`startGateway()` and the worker CLI attach these routes to real ports only when both a GitHub token (`ACS_GITHUB_TOKEN`, else `GITHUB_TOKEN`, else `GH_TOKEN`) and `ACS_CODING_CHECKOUT_ROOT` are set. Otherwise every coding-mission route returns `503 coding_mission_unconfigured`, and worker resume does nothing. A token by itself does not activate the ports. `buildGateway()` does not read this environment; tests keep supplying ports explicitly.

The default publisher pushes `acs/mission/<mission id>` and creates or updates the pull request through `GitHubPullRequestClient`. It does not merge. A timeout or HTTP 408, 429, or 5xx stays `unknown` until a later read of the open pull request. Merge sends that approved head SHA and treats a moved head as `DEGRADED` / `stale_head`. An already-merged pull request is success. Branch protection stays a terminal failure. Ambiguous merge and deploy results are observed before another attempt.

`ACS_CODING_DEPLOY_POLICY` is a JSON object keyed by `owner/name`. A repository that is absent, or whose `required` flag is false, is not deployed. `required: true` is allowed only for `action: "github_deployment"`. Any other required action fails closed with `coding_mission_deployment_unconfigured`. The deployment adapter creates one GitHub deployment for the merge SHA. A timeout is `unknown`; the next step lists deployments for that mission and does not create another while one is already recorded.

Optional settings: `ACS_GITHUB_API` (default `https://api.github.com`), `ACS_CODING_VALIDATE_COMMAND`, and `ACS_CODING_NIMBLE_URL` / `ACS_CODING_NIMBLE_MODEL` / `ACS_CODING_NIMBLE_THRESHOLD` / `ACS_CODING_NIMBLE_TIMEOUT_MS`. The validation command is operator configuration, not mission input. When it is unset, validation fails closed. The command runs with a minimal environment and does not receive the GitHub token.

The default preparation adapter records one manifest commit, `.acs/coding-mission.json`, on the mission branch. It does not invoke a coding model. Nimble still has to select a registry agent with the `coding` capability and a fresh heartbeat. The admission permit id is `coding:<mission id>:<approved change-set hash>`. That permit is stable and idempotent. It is not a JC or DC execution-admission lease.

Mission Control renders coding missions on the approvals view. Approval submits only the hash displayed on that card. A `409 coding_mission_stale_approval` response refreshes the proposal and does not approve the replacement hash.

The checkout for `owner/name` must already exist at `<ACS_CODING_CHECKOUT_ROOT>/owner/name` and must stay inside that root. The default runtime does not clone repositories and does not invent a deployment for a repository without `github_deployment` policy.
