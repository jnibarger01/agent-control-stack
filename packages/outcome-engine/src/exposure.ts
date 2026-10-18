import type { PullRequestSnapshot } from "@agent-control-stack/integration-manager";

/**
 * Honest disclosure of how a pull request could be merged by something other than a human reading an outcome verdict.
 * Modelled from `.github/workflows/*.yml` and pinned by a drift test, never claimed complete: branch protection and
 * CODEOWNERS effects are not visible from here, so the exposure is never reported as "none".
 */
export interface MergePath {
  id: string;
  workflow: string;
  description: string;
  /** True when this path would act on the pull request given only facts visible in the snapshot. */
  appliesTo: (pr: Pick<PullRequestSnapshot, "author" | "isDraft" | "state">) => boolean;
}

export const MODELLED_MERGE_PATHS: readonly MergePath[] = [
  {
    id: "jn_auto_on_pr_event",
    workflow: ".github/workflows/jnibarger01-pr-review-merge.yml",
    description: "auto-merges a non-draft pull request by jnibarger01 once its internal gate is green",
    appliesTo: (pr) => pr.author === "jnibarger01" && !pr.isDraft && pr.state === "OPEN"
  },
  {
    id: "jn_workflow_dispatch",
    workflow: ".github/workflows/jnibarger01-pr-review-merge.yml",
    description: "workflow_dispatch can evaluate and merge any pull request number",
    appliesTo: () => false
  },
  {
    id: "dependabot_auto_merge",
    workflow: ".github/workflows/dependabot-auto-merge.yml",
    description: "enables auto-merge (squash) for dependabot patch and minor updates",
    appliesTo: (pr) => (pr.author === "dependabot" || pr.author === "dependabot[bot]") && pr.state === "OPEN"
  }
];

export type MergeExposure = "likely" | "possible" | "unknown";

export interface HumanControl {
  exposure: MergeExposure;
  matchedPaths: string[];
  modelledPaths: string[];
  note: string;
}

export function externalMergeExposure(
  pr: Pick<PullRequestSnapshot, "author" | "isDraft" | "state"> | undefined,
  targetRepository: string,
  modelledRepository: string
): HumanControl {
  const modelledPaths = MODELLED_MERGE_PATHS.map((path) => path.id);
  if (targetRepository !== modelledRepository || pr === undefined) {
    return {
      exposure: "unknown",
      matchedPaths: [],
      modelledPaths,
      note: "merge paths were modelled for a different repository or no snapshot was read; branch protection is unverified"
    };
  }
  const matchedPaths = MODELLED_MERGE_PATHS.filter((path) => path.appliesTo(pr)).map((path) => path.id);
  return {
    exposure: matchedPaths.length > 0 ? "likely" : "possible",
    matchedPaths,
    modelledPaths,
    note: "a repository workflow, not this verdict, decides merges; workflow_dispatch can merge any pull request; branch protection and CODEOWNERS are unverified"
  };
}
