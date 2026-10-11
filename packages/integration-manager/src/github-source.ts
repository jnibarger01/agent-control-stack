import { runBoundedCommand, subprocessEnv } from "@agent-control-stack/machine-controller";
import type { CheckSnapshot, PullRequestSnapshot, PullRequestSource } from "./types.js";

const PAGE = 100;

const QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:${PAGE},orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{hasNextPage}
      nodes{
        number title state isDraft isCrossRepository headRefName headRefOid baseRefName mergeable reviewDecision
        author{login}
        reviewThreads(first:${PAGE}){totalCount nodes{isResolved}}
        files(first:${PAGE}){totalCount nodes{path}}
        commits(last:1){nodes{commit{statusCheckRollup{contexts(first:${PAGE}){totalCount nodes{
          __typename
          ... on CheckRun{name status conclusion}
          ... on StatusContext{context state}
        }}}}}}
      }
    }
  }
}`;

interface GqlContext {
  __typename: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

interface GqlPull {
  number: number;
  title: string;
  state: PullRequestSnapshot["state"];
  isDraft: boolean;
  isCrossRepository: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: PullRequestSnapshot["mergeable"];
  reviewDecision: PullRequestSnapshot["reviewDecision"];
  author: { login: string } | null;
  reviewThreads: { totalCount: number; nodes: Array<{ isResolved: boolean }> };
  files: { totalCount: number; nodes: Array<{ path: string }> };
  commits: {
    nodes: Array<{
      commit: { statusCheckRollup: { contexts: { totalCount: number; nodes: GqlContext[] } } | null };
    }>;
  };
}

function checkFrom(context: GqlContext): CheckSnapshot {
  if (context.__typename === "CheckRun") {
    const status = (context.status ?? "UNKNOWN") as CheckSnapshot["status"];
    return { name: context.name ?? "unnamed check", status, conclusion: context.conclusion ?? null };
  }
  // A commit status: SUCCESS / FAILURE / ERROR are final, PENDING / EXPECTED are not.
  const state = context.state ?? "UNKNOWN";
  const final = state === "SUCCESS" || state === "FAILURE" || state === "ERROR";
  return {
    name: context.context ?? "unnamed status",
    status: final ? "COMPLETED" : state === "PENDING" || state === "EXPECTED" ? "PENDING" : "UNKNOWN",
    conclusion: final ? state : null
  };
}

/** Pure mapping from the GraphQL node, exported for tests. */
export function snapshotFromGraphQl(node: GqlPull): PullRequestSnapshot {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const contexts = rollup?.contexts.nodes ?? [];
  return {
    number: node.number,
    title: node.title,
    author: node.author?.login ?? "unknown",
    state: node.state,
    isDraft: node.isDraft,
    isCrossRepository: node.isCrossRepository,
    headRef: node.headRefName,
    headSha: node.headRefOid,
    baseRef: node.baseRefName,
    mergeable: node.mergeable,
    reviewDecision: node.reviewDecision,
    unresolvedThreads: node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    checks: contexts.map(checkFrom),
    changedFiles: node.files.nodes.map((file) => file.path),
    truncated: {
      threads: node.reviewThreads.totalCount > node.reviewThreads.nodes.length,
      checks: (rollup?.contexts.totalCount ?? 0) > contexts.length,
      files: node.files.totalCount > node.files.nodes.length
    }
  };
}

export type GhRunner = (args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export function createGhRunner(): GhRunner {
  return async (args) => {
    const result = await runBoundedCommand({
      cwd: process.cwd(),
      command: "gh",
      args,
      env: subprocessEnv(),
      timeoutMs: 60_000,
      terminationGraceMs: 5_000,
      maxOutputBytes: 8 * 1024 * 1024
    });
    return { exitCode: result.timedOut ? null : result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

/**
 * Reads open pull requests through the authenticated `gh` CLI using one GraphQL query. Read-only by construction: the
 * only operation is a query. More than one page of pull requests is an error, not a silent truncation.
 */
export function createGhPullRequestSource(repository: string, run: GhRunner = createGhRunner()): PullRequestSource {
  const [owner, name] = repository.split("/");
  if (!owner || !name || repository.split("/").length !== 2 || !/^[\w.-]+$/u.test(owner) || !/^[\w.-]+$/u.test(name)) {
    throw new Error("repository must be owner/name");
  }
  return {
    async listOpenPullRequests() {
      const result = await run(["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`]);
      if (result.exitCode !== 0) throw new Error(`gh graphql failed: ${result.stderr.trim().slice(0, 200)}`);
      const parsed = JSON.parse(result.stdout) as {
        data?: { repository?: { pullRequests?: { pageInfo: { hasNextPage: boolean }; nodes: GqlPull[] } } };
      };
      const pulls = parsed.data?.repository?.pullRequests;
      if (!pulls) throw new Error("gh graphql returned no pull request data");
      if (pulls.pageInfo.hasNextPage) throw new Error(`more than ${PAGE} open pull requests; refusing a partial view`);
      return pulls.nodes.map(snapshotFromGraphQl);
    }
  };
}
