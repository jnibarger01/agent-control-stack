import {
  runBoundedCommand,
  subprocessEnv,
  type BoundedCommandOptions,
  type BoundedCommandResult
} from "@agent-control-stack/machine-controller";
import { z } from "zod";
import type { CheckSnapshot, MergeMethod, PullRequestReader, PullRequestSnapshot, PullRequestSource } from "./types.js";

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

/**
 * One pull request by number, any state, with the identity fields the open-PR list does not select: the base commit, the
 * commit the check rollup belongs to, and the app behind each check run. A query only; there is no mutation here.
 */
export const PULL_REQUEST_BY_NUMBER_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title state isDraft isCrossRepository headRefName headRefOid baseRefName baseRefOid mergeable reviewDecision
      author{login}
      reviewThreads(first:${PAGE}){totalCount nodes{isResolved}}
      files(first:${PAGE}){totalCount nodes{path}}
      commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:${PAGE}){totalCount nodes{
        __typename
        ... on CheckRun{name status conclusion checkSuite{app{slug}}}
        ... on StatusContext{context state}
      }}}}}}
    }
  }
}`;

const CHECK_STATUSES = new Set(["COMPLETED", "IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"]);

const contextSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    name: z.string().min(1),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    checkSuite: z
      .object({ app: z.object({ slug: z.string() }).nullable() })
      .nullable()
      .optional()
  }),
  z.object({ __typename: z.literal("StatusContext"), context: z.string().min(1), state: z.string() })
]);

/**
 * Every field the gate decides on is validated at runtime: an unrecognized `state`, `mergeable` or `reviewDecision` (GitHub
 * adding a value) or a missing field would otherwise skip every check that only knows today's values and read as eligible.
 * A response that does not match is an error for the whole read, never a partial or defaulted result.
 */
const pullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  isCrossRepository: z.boolean(),
  headRefName: z.string().min(1),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/u),
  baseRefName: z.string().min(1),
  baseRefOid: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .optional(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  author: z.object({ login: z.string().min(1) }).nullable(),
  reviewThreads: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(z.object({ isResolved: z.boolean() }))
  }),
  files: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(z.object({ path: z.string().min(1) }))
  }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          oid: z
            .string()
            .regex(/^[0-9a-f]{40}$/u)
            .optional(),
          statusCheckRollup: z
            .object({
              contexts: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(contextSchema) })
            })
            .nullable()
        })
      })
    )
  })
});

type GqlPull = z.infer<typeof pullSchema>;
type GqlContext = z.infer<typeof contextSchema>;

function checkFrom(context: GqlContext, withIdentity: boolean): CheckSnapshot {
  if (context.__typename === "CheckRun") {
    // A status this code does not know is UNKNOWN, which the gate treats as not finished: never as passing.
    const status = (CHECK_STATUSES.has(context.status) ? context.status : "UNKNOWN") as CheckSnapshot["status"];
    return {
      name: context.name,
      status,
      conclusion: context.conclusion ?? null,
      ...(context.checkSuite !== undefined
        ? { appSlug: context.checkSuite?.app?.slug ?? null, source: "check_run" as const }
        : {})
    };
  }
  // A commit status: SUCCESS / FAILURE / ERROR are final, PENDING / EXPECTED are not, anything else is unknown.
  const final = context.state === "SUCCESS" || context.state === "FAILURE" || context.state === "ERROR";
  return {
    name: context.context,
    status: final ? "COMPLETED" : context.state === "PENDING" || context.state === "EXPECTED" ? "PENDING" : "UNKNOWN",
    conclusion: final ? context.state : null,
    ...(withIdentity ? { appSlug: null, source: "status_context" as const } : {})
  };
}

/** Pure mapping from a validated GraphQL node, exported for tests. */
export function snapshotFromGraphQl(node: GqlPull): PullRequestSnapshot {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const contexts = rollup?.contexts.nodes ?? [];
  // Identity fields are attached only when the read selected them (the by-number query), so list snapshots are unchanged.
  const withIdentity = node.baseRefOid !== undefined;
  const checksCommitSha = node.commits.nodes[0]?.commit.oid;
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
    ...(node.baseRefOid !== undefined ? { baseRefOid: node.baseRefOid } : {}),
    ...(checksCommitSha !== undefined ? { checksCommitSha } : {}),
    mergeable: node.mergeable,
    reviewDecision: node.reviewDecision,
    unresolvedThreads: node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    checks: contexts.map((context) => checkFrom(context, withIdentity)),
    changedFiles: node.files.nodes.map((file) => file.path),
    truncated: {
      threads: node.reviewThreads.totalCount > node.reviewThreads.nodes.length,
      checks: (rollup?.contexts.totalCount ?? 0) > contexts.length,
      files: node.files.totalCount > node.files.nodes.length
    }
  };
}

/** Validates one raw node. Throws without echoing response content, naming only the pull request number if it has one. */
export function parsePullRequestNode(raw: unknown): PullRequestSnapshot {
  const parsed = pullSchema.safeParse(raw);
  if (!parsed.success) {
    const number = (raw as { number?: unknown } | null)?.number;
    const where = typeof number === "number" ? ` for pull request #${number}` : "";
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.slice(0, 2).join(".")))]
      .slice(0, 5)
      .join(", ");
    throw new Error(`unexpected GitHub response${where}; refusing a partial view (fields: ${fields})`);
  }
  return snapshotFromGraphQl(parsed.data);
}

export type GhRunner = (args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export interface GhRunnerOptions {
  /**
   * A GitHub token for this runner's subprocess, passed as `GH_TOKEN` and nowhere else. The subprocess environment is an
   * allowlist (HOME, PATH, ...), so ambient `GH_TOKEN`/`GITHUB_TOKEN` is deliberately not inherited; a caller that has
   * a narrowly scoped, read-only token hands it over here. Without one, `gh` uses its own stored login under HOME.
   */
  token?: string;
}

export function createGhRunner(
  options: GhRunnerOptions = {},
  command: (options: BoundedCommandOptions) => Promise<BoundedCommandResult> = runBoundedCommand
): GhRunner {
  if (options.token !== undefined && !/^[\x21-\x7e]{8,255}$/u.test(options.token)) {
    throw new Error("GitHub token has an unexpected shape");
  }
  return async (args) => {
    const result = await command({
      cwd: process.cwd(),
      command: "gh",
      args,
      env: { ...subprocessEnv(), ...(options.token ? { GH_TOKEN: options.token } : {}) },
      timeoutMs: 60_000,
      terminationGraceMs: 5_000,
      maxOutputBytes: 8 * 1024 * 1024
    });
    return { exitCode: result.timedOut ? null : result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

/**
 * GitHub's own rules: an owner is alphanumeric with single hyphens (up to 39 characters), a repository name is
 * alphanumerics, `.`, `_` and `-` (up to 100) and is never `.` or `..`. Anything else could reach the API path as a
 * traversal segment, so it is refused before it is used.
 */
export function parseRepository(repository: string): { owner: string; name: string } {
  const parts = repository.split("/");
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !name ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("repository must be owner/name");
  }
  return { owner, name };
}

/**
 * Reads open pull requests through the authenticated `gh` CLI using one GraphQL query. Read-only by construction: the
 * only operation is a query. More than one page of pull requests is an error, not a silent truncation.
 */
export function createGhPullRequestSource(repository: string, run: GhRunner = createGhRunner()): PullRequestSource {
  const { owner, name } = parseRepository(repository);
  return {
    async listOpenPullRequests() {
      const result = await run([
        "api",
        "graphql",
        "-f",
        `query=${QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`
      ]);
      if (result.exitCode !== 0) throw new Error(`gh graphql failed: ${result.stderr.trim().slice(0, 200)}`);
      const envelope = z
        .object({
          data: z.object({
            repository: z.object({
              pullRequests: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(z.unknown()) })
            })
          })
        })
        .safeParse(JSON.parse(result.stdout));
      if (!envelope.success) throw new Error("gh graphql returned no pull request data");
      const pulls = envelope.data.data.repository.pullRequests;
      if (pulls.pageInfo.hasNextPage) throw new Error(`more than ${PAGE} open pull requests; refusing a partial view`);
      return pulls.nodes.map(parsePullRequestNode);
    }
  };
}

/**
 * Reads one pull request by number through `gh`, any state. Read-only by construction: the only operation is
 * PULL_REQUEST_BY_NUMBER_QUERY. A missing pull request, a malformed response, or a response without the base commit or
 * the rollup commit is an error for the whole read, never a partial or defaulted snapshot.
 */
export function createGhPullRequestReader(repository: string, run: GhRunner = createGhRunner()): PullRequestReader {
  const { owner, name } = parseRepository(repository);
  return {
    async getPullRequest(number) {
      if (!Number.isSafeInteger(number) || number <= 0)
        throw new Error("pull request number must be a positive integer");
      const result = await run([
        "api",
        "graphql",
        "-f",
        `query=${PULL_REQUEST_BY_NUMBER_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${number}`
      ]);
      if (result.exitCode !== 0) throw new Error(`gh graphql failed: ${result.stderr.trim().slice(0, 200)}`);
      let json: unknown;
      try {
        json = JSON.parse(result.stdout);
      } catch {
        throw new Error("gh graphql returned unparseable output");
      }
      const envelope = z
        .object({ data: z.object({ repository: z.object({ pullRequest: z.unknown().nullable() }) }) })
        .safeParse(json);
      if (!envelope.success) throw new Error("gh graphql returned no pull request data");
      const node = envelope.data.data.repository.pullRequest;
      if (node === null) throw new Error(`pull request #${number} not found`);
      const snapshot = parsePullRequestNode(node);
      if (snapshot.number !== number)
        throw new Error(`gh returned pull request #${snapshot.number}, expected #${number}`);
      if (snapshot.baseRefOid === undefined || snapshot.checksCommitSha === undefined) {
        throw new Error(`pull request #${number} response lacks the base or rollup commit; refusing a partial view`);
      }
      return snapshot;
    }
  };
}

export interface RepositoryMergeSettings {
  allow_merge_commit?: unknown;
  allow_squash_merge?: unknown;
  allow_rebase_merge?: unknown;
}

/**
 * The method the review-and-merge workflow would use: the first allowed of merge commit, squash, rebase, in that order
 * (`.github/workflows/jnibarger01-pr-review-merge.yml`). A test reads the workflow and fails if this order drifts. Settings
 * that allow none, or that are not plain booleans, give `undefined`: the caller must fail closed, never default.
 */
export function selectMergeMethod(settings: RepositoryMergeSettings): MergeMethod | undefined {
  const bools = [settings.allow_merge_commit, settings.allow_squash_merge, settings.allow_rebase_merge];
  if (!bools.every((value) => typeof value === "boolean")) return undefined;
  if (settings.allow_merge_commit === true) return "merge";
  if (settings.allow_squash_merge === true) return "squash";
  if (settings.allow_rebase_merge === true) return "rebase";
  return undefined;
}

/** Reads the repository's merge settings (read-only) and applies `selectMergeMethod`. Throws if none can be determined. */
export async function readRepositoryMergeMethod(
  repository: string,
  run: GhRunner = createGhRunner()
): Promise<MergeMethod> {
  const { owner, name } = parseRepository(repository);
  const result = await run(["api", `repos/${owner}/${name}`]);
  if (result.exitCode !== 0) throw new Error(`gh api failed: ${result.stderr.trim().slice(0, 200)}`);
  const method = selectMergeMethod(JSON.parse(result.stdout) as RepositoryMergeSettings);
  if (!method) throw new Error("repository settings expose no usable pull-request merge method");
  return method;
}
