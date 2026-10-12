import { runBoundedCommand, subprocessEnv } from "@agent-control-stack/machine-controller";
import type { MergeSimulation } from "./types.js";

const GIT_TIMEOUT_MS = 60_000;
const SHA = /^[0-9a-f]{40}$/u;

/**
 * Simulation must not depend on, or be steered by, the host's git configuration. Simulated merge commits need an identity
 * (a runner with no global identity would otherwise fail `commit-tree` and report nothing mergeable); the identity and
 * dates are fixed, which also makes the synthetic commit ids deterministic. Global and system configuration are disabled
 * outright, so the same repository gives the same verdict on every host.
 */
const SIMULATION_GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  // No host configuration at all. A merge driver, attribute file or hook named in the operator's ~/.gitconfig or in
  // /etc/gitconfig could be selected by a pull request's .gitattributes: it would execute a helper and could turn a real
  // conflict into a clean result, making the verdict depend on the machine. Only the settings passed here apply.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
  // HOME and XDG_CONFIG_HOME also locate ~/.config/git/attributes and ignore files, so point them nowhere.
  HOME: "/nonexistent-acs-simulation-home",
  XDG_CONFIG_HOME: "/nonexistent-acs-simulation-xdg",
  GIT_AUTHOR_NAME: "ACS Integration Simulation",
  GIT_AUTHOR_EMAIL: "acs-integration-simulation@users.noreply.github.com",
  GIT_COMMITTER_NAME: "ACS Integration Simulation",
  GIT_COMMITTER_EMAIL: "acs-integration-simulation@users.noreply.github.com",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
} as const;

export type GitRunner = (args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/** Runs git without a shell, with the repo's bounded-subprocess limits, in `cwd`. */
export function createGitRunner(cwd: string): GitRunner {
  return async (args) => {
    const result = await runBoundedCommand({
      cwd,
      command: "git",
      args,
      env: { ...subprocessEnv(), ...SIMULATION_GIT_ENV },
      timeoutMs: GIT_TIMEOUT_MS,
      terminationGraceMs: 5_000,
      maxOutputBytes: 4 * 1024 * 1024
    });
    return { exitCode: result.timedOut ? null : result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

/**
 * Merge simulation with `git merge-tree --write-tree`. It computes the merge result in memory: no working tree, no ref,
 * no index is touched. It can add unreferenced objects to the object database, which is why the repository passed in must
 * be a disposable clone (see `createIsolatedClone`), never a developer's checkout.
 */
export class MergeSimulator {
  constructor(private readonly git: GitRunner) {}

  async resolveCommit(ref: string): Promise<string | undefined> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const sha = result.stdout.trim();
    return result.exitCode === 0 && SHA.test(sha) ? sha : undefined;
  }

  async hasCommit(sha: string): Promise<boolean> {
    if (!SHA.test(sha)) return false;
    return (await this.git(["cat-file", "-e", `${sha}^{commit}`])).exitCode === 0;
  }

  /** Commits the base has gained since `head` diverged from it. */
  async behindBy(baseSha: string, headSha: string): Promise<number | undefined> {
    const base = await this.git(["merge-base", baseSha, headSha]);
    const mergeBase = base.stdout.trim();
    if (base.exitCode !== 0 || !SHA.test(mergeBase)) return undefined;
    const count = await this.git(["rev-list", "--count", `${mergeBase}..${baseSha}`]);
    const n = Number.parseInt(count.stdout.trim(), 10);
    return count.exitCode === 0 && Number.isInteger(n) ? n : undefined;
  }

  /** Result tree of merging `headSha` into `baseSha`, or the conflicting paths. Never throws on a conflict. */
  async simulate(baseSha: string, headSha: string): Promise<MergeSimulation & { tree?: string }> {
    if (!SHA.test(baseSha) || !SHA.test(headSha)) {
      return { evaluated: false, clean: false, conflicts: [], behindBy: 0, detail: "not a full commit id" };
    }
    if (!(await this.hasCommit(baseSha)) || !(await this.hasCommit(headSha))) {
      return {
        evaluated: false,
        clean: false,
        conflicts: [],
        behindBy: 0,
        detail: "commit is not present in the isolated clone"
      };
    }
    const behind = (await this.behindBy(baseSha, headSha)) ?? 0;
    const merged = await this.git(["merge-tree", "--write-tree", "--name-only", "--no-messages", baseSha, headSha]);
    if (merged.exitCode === 0) {
      const tree = merged.stdout.split("\n")[0]?.trim();
      return tree && SHA.test(tree)
        ? { evaluated: true, clean: true, conflicts: [], behindBy: behind, tree }
        : { evaluated: false, clean: false, conflicts: [], behindBy: behind, detail: "merge-tree returned no tree" };
    }
    if (merged.exitCode === 1) {
      // First line is the (conflicted) tree, then the conflicted paths, then a blank line.
      const lines = merged.stdout.split("\n").slice(1);
      const conflicts = lines.slice(0, lines.indexOf("") === -1 ? lines.length : lines.indexOf("")).filter(Boolean);
      return { evaluated: true, clean: false, conflicts: [...new Set(conflicts)].sort(), behindBy: behind };
    }
    return {
      evaluated: false,
      clean: false,
      conflicts: [],
      behindBy: behind,
      detail: `git merge-tree failed (${merged.exitCode ?? "timeout"}): ${merged.stderr.trim().slice(0, 200)}`
    };
  }

  /** A synthetic merge commit for chaining simulations. Unreferenced: it exists only in the object database. */
  async syntheticMerge(tree: string, parents: string[]): Promise<string | undefined> {
    const args = [
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      "acs integration simulation"
    ];
    const result = await this.git(args);
    const sha = result.stdout.trim();
    return result.exitCode === 0 && SHA.test(sha) ? sha : undefined;
  }
}

/**
 * A disposable bare clone for simulation. Its refs are copies, so nothing the engine does can move a ref in `source`.
 * The caller removes `target` when finished.
 */
export async function createIsolatedClone(source: string, target: string): Promise<GitRunner> {
  const run = createGitRunner(process.cwd());
  const cloned = await run(["clone", "--bare", "--quiet", "--no-hardlinks", source, target]);
  if (cloned.exitCode !== 0) throw new Error(`isolated clone failed: ${cloned.stderr.trim().slice(0, 200)}`);
  return createGitRunner(target);
}
