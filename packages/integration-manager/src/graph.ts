import type { PullRequestSnapshot } from "./types.js";

export interface DependencyAnalysis {
  /** number -> numbers it must wait for (open pull requests whose head is this one's base). */
  dependsOn: Map<number, number[]>;
  /** Pull requests that are part of a dependency cycle. They can never be ordered. */
  cyclic: Set<number>;
  /** Pull requests whose base is neither the integration target nor another open pull request's head. */
  detached: Set<number>;
  /** Earliest first. Excludes cyclic and detached pull requests. Ties break by number so the order is deterministic. */
  order: number[];
}

/** Stacked pull requests: B depends on A when B's base branch is A's head branch. */
export function analyzeDependencies(prs: readonly PullRequestSnapshot[], targetRef: string): DependencyAnalysis {
  const byHead = new Map<string, PullRequestSnapshot[]>();
  for (const pr of prs) byHead.set(pr.headRef, [...(byHead.get(pr.headRef) ?? []), pr]);

  const dependsOn = new Map<number, number[]>();
  const detached = new Set<number>();
  for (const pr of prs) {
    if (pr.baseRef === targetRef) {
      dependsOn.set(pr.number, []);
      continue;
    }
    const parents = (byHead.get(pr.baseRef) ?? []).filter((candidate) => candidate.number !== pr.number);
    if (parents.length === 0) detached.add(pr.number);
    dependsOn.set(pr.number, parents.map((parent) => parent.number).sort((a, b) => a - b));
  }

  // Kahn's algorithm. Whatever is left after it stalls is on a cycle or hangs off one.
  const remaining = new Map<number, Set<number>>();
  for (const pr of prs) {
    if (detached.has(pr.number)) continue;
    remaining.set(pr.number, new Set((dependsOn.get(pr.number) ?? []).filter((n) => !detached.has(n))));
  }
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
  const cyclic = new Set(remaining.keys());
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
  for (let i = order.length - 1; i >= 0; i -= 1) if (detached.has(order[i]!)) order.splice(i, 1);
  return { dependsOn, cyclic, detached, order };
}

/** Pull requests that touch the same files. Advisory: overlapping files may or may not conflict. */
export function findOverlaps(prs: readonly PullRequestSnapshot[]): Map<number, Array<{ number: number; files: string[] }>> {
  const result = new Map<number, Array<{ number: number; files: string[] }>>();
  for (const pr of prs) {
    const mine = new Set(pr.changedFiles);
    const overlaps: Array<{ number: number; files: string[] }> = [];
    for (const other of prs) {
      if (other.number === pr.number) continue;
      const shared = other.changedFiles.filter((file) => mine.has(file)).sort();
      if (shared.length > 0) overlaps.push({ number: other.number, files: shared });
    }
    result.set(pr.number, overlaps.sort((a, b) => a.number - b.number));
  }
  return result;
}
