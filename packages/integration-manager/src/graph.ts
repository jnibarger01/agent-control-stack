import type { PullRequestSnapshot } from "./types.js";

export interface DependencyAnalysis {
  /** number -> numbers it must wait for (open pull requests whose head is this one's base). */
  dependsOn: Map<number, number[]>;
  /** Pull requests that are members of a dependency cycle. They can never be ordered. */
  cyclic: Set<number>;
  /** Pull requests that are not in a cycle but depend, directly or not, on one that is. Blocked until the cycle is broken. */
  blockedByCycle: Set<number>;
  /** Pull requests whose base is neither the integration target nor another open pull request's head. */
  detached: Set<number>;
  /** Earliest first. Excludes cyclic, cycle-blocked and detached pull requests. Ties break by number so the order is deterministic. */
  order: number[];
}

/**
 * Stacked pull requests: B depends on A when B's base branch is A's head branch. A base branch lives in the repository
 * being merged into, so only a pull request whose head is in that same repository can be a parent: a fork's branch that
 * happens to share the name is a different branch and is never matched.
 */
export function analyzeDependencies(prs: readonly PullRequestSnapshot[], targetRef: string): DependencyAnalysis {
  const byHead = new Map<string, PullRequestSnapshot[]>();
  for (const pr of prs) {
    if (pr.isCrossRepository) continue;
    byHead.set(pr.headRef, [...(byHead.get(pr.headRef) ?? []), pr]);
  }

  const dependsOn = new Map<number, number[]>();
  const detached = new Set<number>();
  for (const pr of prs) {
    if (pr.baseRef === targetRef) {
      dependsOn.set(pr.number, []);
      continue;
    }
    const parents = (byHead.get(pr.baseRef) ?? []).filter((candidate) => candidate.number !== pr.number);
    if (parents.length === 0) detached.add(pr.number);
    dependsOn.set(
      pr.number,
      parents.map((parent) => parent.number).sort((a, b) => a - b)
    );
  }

  // A pull request stacked on a detached parent can never merge cleanly into the target either, at any depth.
  let changed = true;
  while (changed) {
    changed = false;
    for (const pr of prs) {
      if (detached.has(pr.number)) continue;
      if ((dependsOn.get(pr.number) ?? []).some((parent) => detached.has(parent))) {
        detached.add(pr.number);
        changed = true;
      }
    }
  }

  // Strongly connected components (Tarjan). A component of more than one pull request is a genuine cycle; anything that
  // merely depends on one is blocked by it, which is a different thing and is reported differently.
  const live = prs.filter((pr) => !detached.has(pr.number)).map((pr) => pr.number);
  const liveSet = new Set(live);
  const edges = (n: number) => (dependsOn.get(n) ?? []).filter((m) => liveSet.has(m));
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const cyclic = new Set<number>();
  let counter = 0;
  const visit = (v: number): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) for (const member of component) cyclic.add(member);
    }
  };
  for (const v of [...live].sort((a, b) => a - b)) if (!index.has(v)) visit(v);

  const blockedByCycle = new Set<number>();
  changed = true;
  while (changed) {
    changed = false;
    for (const v of live) {
      if (cyclic.has(v) || blockedByCycle.has(v)) continue;
      if (edges(v).some((parent) => cyclic.has(parent) || blockedByCycle.has(parent))) {
        blockedByCycle.add(v);
        changed = true;
      }
    }
  }

  // Everything else is acyclic and fully attached, so a topological order exists. Ties break by number: deterministic.
  const remaining = new Map<number, Set<number>>();
  for (const v of live) if (!cyclic.has(v) && !blockedByCycle.has(v)) remaining.set(v, new Set(edges(v)));
  const order: number[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, waits]) => waits.size === 0)
      .map(([number]) => number)
      .sort((a, b) => a - b);
    if (ready.length === 0) break;
    const next = ready[0]!;
    order.push(next);
    remaining.delete(next);
    for (const waits of remaining.values()) waits.delete(next);
  }
  return { dependsOn, cyclic, blockedByCycle, detached, order };
}

/** Pull requests that touch the same files. Advisory: overlapping files may or may not conflict. */
export function findOverlaps(
  prs: readonly PullRequestSnapshot[]
): Map<number, Array<{ number: number; files: string[] }>> {
  const result = new Map<number, Array<{ number: number; files: string[] }>>();
  for (const pr of prs) {
    const mine = new Set(pr.changedFiles);
    const overlaps: Array<{ number: number; files: string[] }> = [];
    for (const other of prs) {
      if (other.number === pr.number) continue;
      const shared = other.changedFiles.filter((file) => mine.has(file)).sort();
      if (shared.length > 0) overlaps.push({ number: other.number, files: shared });
    }
    result.set(
      pr.number,
      overlaps.sort((a, b) => a.number - b.number)
    );
  }
  return result;
}
