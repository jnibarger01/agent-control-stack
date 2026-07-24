import type { GraphNodeDefinition } from "./contract.js";

export function resourcesConflict(left: GraphNodeDefinition, right: GraphNodeDefinition): boolean {
  for (const leftResource of left.resources.filesystem) {
    for (const rightResource of right.resources.filesystem) {
      if (
        (leftResource.access === "WRITE" || rightResource.access === "WRITE") &&
        filesystemScopesOverlap(leftResource.scope, rightResource.scope)
      ) {
        return true;
      }
    }
  }

  return (
    intersects(left.resources.gitWorktrees, right.resources.gitWorktrees) ||
    intersects(left.resources.ports, right.resources.ports) ||
    intersects(left.resources.browserProfiles, right.resources.browserProfiles) ||
    intersects(left.resources.services, right.resources.services) ||
    intersects(left.resources.externalTargets, right.resources.externalTargets)
  );
}

export function filesystemScopesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function normalizeScope(scope: string): string {
  return scope.replace(/\/\*\*$/u, "").replace(/\/+$/u, "");
}

function intersects<T>(left: readonly T[], right: readonly T[]): boolean {
  const rightValues = new Set(right);
  return left.some((value) => rightValues.has(value));
}
