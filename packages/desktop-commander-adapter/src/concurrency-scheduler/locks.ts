import { isAbsolute, relative, sep } from "node:path";
import type { ResourceClaim } from "./types.js";

interface HeldLock {
  exclusive?: string;
  shared: Set<string>;
}

export function normalizeResourceClaims(claims: readonly ResourceClaim[]): ResourceClaim[] {
  const byKey = new Map<string, ResourceClaim["mode"]>();
  for (const claim of claims) {
    const key = claim.key.trim();
    if (!key) continue;
    const existing = byKey.get(key);
    if (claim.mode === "exclusive" || existing === undefined) {
      byKey.set(key, claim.mode);
    }
  }
  return [...byKey.entries()]
    .map(([key, mode]) => ({ key, mode }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function resourceClaimsConflict(
  left: readonly ResourceClaim[],
  right: readonly ResourceClaim[]
): boolean {
  for (const leftClaim of normalizeResourceClaims(left)) {
    for (const rightClaim of normalizeResourceClaims(right)) {
      if (
        resourcesOverlap(leftClaim.key, rightClaim.key) &&
        (leftClaim.mode === "exclusive" || rightClaim.mode === "exclusive")
      ) {
        return true;
      }
    }
  }
  return false;
}

export class ResourceLockTable {
  private readonly locks = new Map<string, HeldLock>();

  canAcquire(ownerId: string, claims: readonly ResourceClaim[]): boolean {
    for (const claim of normalizeResourceClaims(claims)) {
      for (const [heldKey, held] of this.locks) {
        if (!resourcesOverlap(claim.key, heldKey)) continue;
        if (claim.mode === "shared") {
          if (held.exclusive && held.exclusive !== ownerId) return false;
          continue;
        }
        if (held.exclusive && held.exclusive !== ownerId) return false;
        if ([...held.shared].some((owner) => owner !== ownerId)) return false;
      }
    }
    return true;
  }

  acquire(ownerId: string, claims: readonly ResourceClaim[]): void {
    const normalized = normalizeResourceClaims(claims);
    if (!this.canAcquire(ownerId, normalized)) {
      throw new Error("resource lock acquisition attempted without full admission");
    }
    for (const claim of normalized) {
      const held = this.locks.get(claim.key) ?? { shared: new Set<string>() };
      if (claim.mode === "exclusive") {
        held.exclusive = ownerId;
        held.shared.delete(ownerId);
      } else if (held.exclusive !== ownerId) {
        held.shared.add(ownerId);
      }
      this.locks.set(claim.key, held);
    }
  }

  release(ownerId: string): void {
    for (const [key, held] of this.locks) {
      if (held.exclusive === ownerId) held.exclusive = undefined;
      held.shared.delete(ownerId);
      if (!held.exclusive && held.shared.size === 0) {
        this.locks.delete(key);
      }
    }
  }

  blockingKeys(ownerId: string, claims: readonly ResourceClaim[]): string[] {
    const blocking = new Set<string>();
    for (const claim of normalizeResourceClaims(claims)) {
      for (const [heldKey, held] of this.locks) {
        if (!resourcesOverlap(claim.key, heldKey)) continue;
        const blocked =
          claim.mode === "shared"
            ? Boolean(held.exclusive && held.exclusive !== ownerId)
            : Boolean(
                (held.exclusive && held.exclusive !== ownerId) ||
                  [...held.shared].some((owner) => owner !== ownerId)
              );
        if (blocked) blocking.add(heldKey);
      }
    }
    return [...blocking].sort((left, right) => left.localeCompare(right));
  }
}

function resourcesOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const a = splitPathResource(left);
  const b = splitPathResource(right);
  if (!a || !b) return false;
  if (a.kind === "file" && b.kind === "file") return false;
  if (a.kind === "dir" && b.kind === "dir") {
    return containsPath(a.path, b.path) || containsPath(b.path, a.path);
  }
  if (a.kind === "dir" && b.kind === "file") return containsPath(a.path, b.path);
  if (a.kind === "file" && b.kind === "dir") return containsPath(b.path, a.path);
  return false;
}

function splitPathResource(key: string): { kind: "file" | "dir"; path: string } | undefined {
  if (key.startsWith("file:")) return { kind: "file", path: key.slice(5) };
  if (key.startsWith("dir:")) return { kind: "dir", path: key.slice(4) };
  return undefined;
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
