# Autonomous coding missions

A coding mission prepares an immutable change set without a human approval prompt, then stops at one decision: approve that exact change set. Merge, deployment, and verification run only after that approval still matches the stored proposal.

Preparation uses the ACS Nimble router (`nimble.noul.highest-score.v1`). JEV does not select workers. Policy denials fail the mission. They are not turned into extra approval prompts, and there is no bypass flag.

The durable states are `PLANNING`, `RUNNING`, `RECONCILING`, `VALIDATING`, `PREPARING_CHANGE_SET`, `PUBLISHING_PROPOSAL`, `WAITING_FOR_APPROVAL`, `APPROVED`, `EXECUTING`, `VERIFYING`, `COMPLETED`, `FAILED`, and `DEGRADED`.

`WAITING_FOR_APPROVAL` is the only routine human boundary. The approval view shows the summary, repository, files, head commit, canonical pull request, validation checks, change-set hash, and deployment impact. Approving a different hash fails closed. An already-issued authority grant can cover that same hash; the controller does not mint grants.

One mission owns one branch, `acs/mission/<mission id>`, and one pull request. Unknown outcomes of publish, merge, or deploy stay unknown until observation. They are not retried blindly. Completion is a single effect and requires operation results, a merge SHA, verification evidence, and deployment evidence when the repository policy requires it.

HTTP surface, when the gateway is given coding-mission ports:

- `POST /coding-missions` creates the mission and runs preparation until it is waiting, approved by a grant, or stopped.
- `GET /coding-missions/:id` returns the approval view.
- `POST /coding-missions/:id/approve` records the human decision and continues execution in the same request.

Ports for coding, GitHub, merge, and deploy are injected. Repositories without a deployment policy do not receive an invented restart.
