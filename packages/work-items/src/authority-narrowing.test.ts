import { describe, expect, it } from "vitest";
import {
  assertAuthorityNarrowed,
  authorityNarrowingViolations,
  type AutonomousAuthorityDefinition
} from "./authority-narrowing.js";

const NOW = new Date("2026-10-09T12:00:00.000Z");

function parent(overrides: Partial<AutonomousAuthorityDefinition> = {}): AutonomousAuthorityDefinition {
  return {
    executingActorId: "actor:coder",
    scope: [
      { kind: "path", id: "/work/repo", coverage: "descendants" },
      { kind: "service", id: "svc-a", coverage: "exact" }
    ],
    toolClasses: [
      { runtime: "desktop_commander", toolName: "write_file" },
      { runtime: "jace_commander", toolName: "git_commit" }
    ],
    maximumPrivileges: ["fs.read", "fs.write", "git.write"],
    expiresAt: "2026-10-09T18:00:00.000Z",
    limits: { maxOperations: 20, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 },
    ...overrides
  };
}

function child(overrides: Partial<AutonomousAuthorityDefinition> = {}): AutonomousAuthorityDefinition {
  return {
    ...parent(),
    scope: [{ kind: "path", id: "/work/repo/src", coverage: "descendants" }],
    ...overrides
  };
}

describe("authority narrowing", () => {
  it("accepts an identical definition and a strict subset", () => {
    expect(authorityNarrowingViolations(parent(), parent(), NOW)).toEqual([]);
    const narrow = child({
      scope: [{ kind: "path", id: "/work/repo", coverage: "exact" }],
      toolClasses: [{ runtime: "desktop_commander", toolName: "write_file" }],
      maximumPrivileges: ["fs.read"],
      expiresAt: "2026-10-09T13:00:00.000Z",
      limits: { maxOperations: 5, maxRuntimeMs: 60_000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
    });
    expect(assertAuthorityNarrowed(parent(), narrow, NOW)).toEqual(narrow);
  });

  it("refuses an extra tool, privilege, or looser limit and does not trim it", () => {
    expect(
      authorityNarrowingViolations(
        parent(),
        child({ toolClasses: [{ runtime: "jace_commander", toolName: "privileged_exec" }] }),
        NOW
      )
    ).toEqual(["tool jace_commander:privileged_exec exceeds parent"]);
    expect(authorityNarrowingViolations(parent(), child({ maximumPrivileges: ["fs.read", "deploy"] }), NOW)).toEqual([
      "privilege deploy exceeds parent"
    ]);
    const loose = { maxOperations: 21, maxRuntimeMs: 600_001, maxParallelOperations: 5, maxAttemptsPerOperation: 4 };
    expect(authorityNarrowingViolations(parent(), child({ limits: loose }), NOW)).toHaveLength(4);
    expect(() => assertAuthorityNarrowed(parent(), child({ maximumPrivileges: ["fs.read", "deploy"] }), NOW)).toThrow(
      expect.objectContaining({ code: "authority_escalation" })
    );
  });

  describe("scope", () => {
    it("refuses a sibling or parent directory, and traversal lookalikes", () => {
      for (const id of ["/work/repo2", "/work", "/work/repo/../other", "/"]) {
        const scope = [{ kind: "path" as const, id, coverage: "exact" as const }];
        expect(authorityNarrowingViolations(parent(), child({ scope }), NOW).length, id).toBeGreaterThan(0);
      }
    });
    it("a descendants child needs a descendants parent; exact parents never cover descendants", () => {
      const exactParent = parent({ scope: [{ kind: "path", id: "/work/repo", coverage: "exact" }] });
      const wide = [{ kind: "path" as const, id: "/work/repo", coverage: "descendants" as const }];
      expect(authorityNarrowingViolations(exactParent, child({ scope: wide }), NOW)).toHaveLength(1);
      const sub = [{ kind: "path" as const, id: "/work/repo/src", coverage: "exact" as const }];
      expect(authorityNarrowingViolations(exactParent, child({ scope: sub }), NOW)).toHaveLength(1);
    });
    it("does not let a different resource kind satisfy a path parent", () => {
      const scope = [{ kind: "service" as const, id: "/work/repo", coverage: "exact" as const }];
      expect(authorityNarrowingViolations(parent(), child({ scope }), NOW)).toHaveLength(1);
    });
  });

  it("refuses a child that outlives the parent and any request against an expired parent", () => {
    expect(authorityNarrowingViolations(parent(), child({ expiresAt: "2026-10-09T18:00:01.000Z" }), NOW)).toEqual([
      "child outlives parent authority"
    ]);
    const late = new Date("2026-10-09T18:00:00.000Z");
    expect(() => assertAuthorityNarrowed(parent(), child({ expiresAt: "2026-10-09T17:00:00.000Z" }), late)).toThrow(
      expect.objectContaining({ code: "authority_expired" })
    );
  });

  it("binds the executing actor and a pinned manifest", () => {
    expect(authorityNarrowingViolations(parent(), child({ executingActorId: "actor:other" }), NOW)).toEqual([
      "child names a different executing actor"
    ]);
    const hashA = "a".repeat(64);
    const pinned = parent({ manifestHash: hashA });
    expect(authorityNarrowingViolations(pinned, child({ manifestHash: undefined }), NOW)).toHaveLength(1);
    expect(authorityNarrowingViolations(pinned, child({ manifestHash: "b".repeat(64) }), NOW)).toHaveLength(1);
    expect(authorityNarrowingViolations(pinned, child({ manifestHash: hashA }), NOW)).toEqual([]);
  });

  it("allows a different executing actor only when the caller opts in, and still enforces everything else", () => {
    const other = child({ executingActorId: "actor:other" });
    expect(authorityNarrowingViolations(parent(), other, NOW)).toHaveLength(1);
    expect(authorityNarrowingViolations(parent(), other, NOW, { allowActorChange: true })).toEqual([]);
    expect(
      authorityNarrowingViolations(
        parent(),
        child({ executingActorId: "actor:other", maximumPrivileges: ["deploy"] }),
        NOW,
        {
          allowActorChange: true
        }
      )
    ).toEqual(["privilege deploy exceeds parent"]);
    expect(assertAuthorityNarrowed(parent(), other, NOW, { allowActorChange: true })).toEqual(other);
  });

  it("treats malformed input as a violation, never as an empty list", () => {
    expect(authorityNarrowingViolations(parent(), { ...child(), extra: true }, NOW)).toEqual([
      "child authority is not a valid definition"
    ]);
    expect(authorityNarrowingViolations(null, child(), NOW)).toEqual(["parent authority is not a valid definition"]);
    expect(() => assertAuthorityNarrowed(parent(), undefined, NOW)).toThrow(/not a subset/);
  });

  it("is transitive: a grandchild within the child is within the grandparent", () => {
    const mid = child({ maximumPrivileges: ["fs.read", "fs.write"] });
    const leaf = child({
      scope: [{ kind: "path", id: "/work/repo/src/lib", coverage: "exact" }],
      maximumPrivileges: ["fs.read"]
    });
    expect(authorityNarrowingViolations(parent(), mid, NOW)).toEqual([]);
    expect(authorityNarrowingViolations(mid, leaf, NOW)).toEqual([]);
    expect(authorityNarrowingViolations(parent(), leaf, NOW)).toEqual([]);
  });
});
