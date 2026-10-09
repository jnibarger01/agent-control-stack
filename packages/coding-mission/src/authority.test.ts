import { describe, expect, it } from "vitest";
import {
  PRIVILEGED_PRIVILEGES,
  definitionHash,
  isSubset,
  narrowDefinition,
  type AutonomousAuthorityDefinition
} from "./authority.js";

const NOW = new Date("2026-10-09T00:00:00.000Z");
const parent: AutonomousAuthorityDefinition = {
  executingActorId: "actor:lead",
  scope: [
    { kind: "path", id: "/repo/acme/app", coverage: "descendants" },
    { kind: "path", id: "/repo/acme/docs", coverage: "descendants" }
  ],
  toolClasses: [
    { runtime: "desktop_commander", toolName: "read_file" },
    { runtime: "desktop_commander", toolName: "write_file" }
  ],
  maximumPrivileges: ["fs.read", "fs.write", "process.privileged", "deploy"],
  expiresAt: "2026-10-09T01:00:00.000Z",
  limits: { maxOperations: 20, maxRuntimeMs: 600_000, maxParallelOperations: 4, maxAttemptsPerOperation: 3 }
};
const ok = (result: ReturnType<typeof narrowDefinition>) => {
  if (!result.ok) throw new Error(`expected narrowing, got ${result.reasons.join(" | ")}`);
  return result.definition;
};
const no = (result: ReturnType<typeof narrowDefinition>) => {
  if (result.ok) throw new Error("expected denial");
  return result.reasons;
};

describe("narrowDefinition (policy on top of the shared subset check)", () => {
  it("inherits the parent minus privileged privileges by default", () => {
    const child = ok(narrowDefinition({ parent, now: NOW }));
    expect(child.maximumPrivileges).toEqual(["fs.read", "fs.write"]);
    expect(child.scope).toEqual(parent.scope);
    expect(isSubset(child, parent, NOW)).toBe(true);
  });

  it("accepts a strict subset and returns it unchanged", () => {
    const requested = {
      ...parent,
      scope: [{ kind: "path" as const, id: "/repo/acme/app/src", coverage: "exact" as const }],
      maximumPrivileges: ["fs.read" as const],
      toolClasses: [{ runtime: "desktop_commander" as const, toolName: "read_file" }]
    };
    expect(ok(narrowDefinition({ parent, requested, now: NOW }))).toEqual(requested);
  });

  it("denies an escalation with the reasons instead of trimming it", () => {
    const reasons = no(
      narrowDefinition({
        parent,
        now: NOW,
        requested: {
          ...parent,
          scope: [{ kind: "path", id: "/repo/other", coverage: "descendants" }],
          toolClasses: [{ runtime: "desktop_commander", toolName: "kill_process" }],
          limits: { ...parent.limits, maxOperations: 99 }
        }
      })
    );
    expect(reasons.join("\n")).toMatch(/escalation:scope path:\/repo\/other/);
    expect(reasons.join("\n")).toMatch(/escalation:tool desktop_commander:kill_process/);
    expect(reasons.join("\n")).toMatch(/escalation:limit maxOperations/);
  });

  it("denies a privilege the parent lacks", () => {
    const unprivileged = { ...parent, maximumPrivileges: ["fs.read" as const] };
    expect(
      no(
        narrowDefinition({
          parent: unprivileged,
          now: NOW,
          requested: { ...unprivileged, maximumPrivileges: ["process.privileged"] }
        })
      ).join()
    ).toMatch(/escalation:privilege process.privileged exceeds parent/);
  });

  it("keeps privileged privileges out of children unless mission policy allows them AND the parent holds them", () => {
    const withPrivilege = { ...parent, maximumPrivileges: ["fs.read" as const, "process.privileged" as const] };
    expect(
      no(narrowDefinition({ parent, now: NOW, requested: { ...parent, maximumPrivileges: ["process.privileged"] } }))
    ).toContain("privileged_child_not_allowed:process.privileged");
    const allowed = ok(
      narrowDefinition({
        parent,
        now: NOW,
        policy: { allowPrivilegedChildren: true },
        requested: { ...withPrivilege, maximumPrivileges: ["process.privileged"] }
      })
    );
    expect(allowed.maximumPrivileges).toEqual(["process.privileged"]);
    expect(
      ok(narrowDefinition({ parent, now: NOW, policy: { allowPrivilegedChildren: true } })).maximumPrivileges
    ).toContain("process.privileged");
    for (const privilege of ["process.privileged", "service.control", "deploy", "remote", "secret.read"]) {
      expect(PRIVILEGED_PRIVILEGES.has(privilege)).toBe(true);
    }
  });

  it("applies policy denials to requests and to inheritance", () => {
    const policy = { deniedPrivileges: ["fs.write"] };
    expect(ok(narrowDefinition({ parent, now: NOW, policy })).maximumPrivileges).toEqual(["fs.read"]);
    expect(
      no(narrowDefinition({ parent, now: NOW, policy, requested: { ...parent, maximumPrivileges: ["fs.write"] } }))
    ).toContain("privilege_denied_by_mission_policy:fs.write");
  });

  it("bounds a child's lifetime by policy TTL and never lets it outlive its parent", () => {
    expect(ok(narrowDefinition({ parent, now: NOW, policy: { maxChildTtlMs: 60_000 } })).expiresAt).toBe(
      "2026-10-09T00:01:00.000Z"
    );
    expect(
      no(
        narrowDefinition({
          parent,
          now: NOW,
          policy: { maxChildTtlMs: 60_000 },
          requested: { ...parent, maximumPrivileges: ["fs.read"] }
        })
      )
    ).toContain("expiry_exceeds_policy");
    expect(
      no(
        narrowDefinition({
          parent,
          now: NOW,
          requested: { ...parent, maximumPrivileges: ["fs.read"], expiresAt: "2026-10-09T05:00:00.000Z" }
        })
      ).join()
    ).toMatch(/escalation:child outlives parent authority/);
  });

  it("fails when the parent has expired or either side is malformed", () => {
    expect(no(narrowDefinition({ parent: { ...parent, expiresAt: "2026-10-08T00:00:00.000Z" }, now: NOW }))).toEqual([
      "authority_expired"
    ]);
    expect(no(narrowDefinition({ parent: { nonsense: true }, now: NOW }))).toEqual(["parent_authority_invalid"]);
    expect(no(narrowDefinition({ parent, now: NOW, requested: { nonsense: true } }))).toEqual([
      "requested_authority_invalid"
    ]);
  });

  it("denies when only privileged privileges would remain", () => {
    expect(no(narrowDefinition({ parent: { ...parent, maximumPrivileges: ["deploy"] }, now: NOW }))).toEqual([
      "no_authority_remains"
    ]);
  });

  it("a grandchild is a subset of its parent and the root, and cannot reach back up", () => {
    const child = ok(
      narrowDefinition({ parent, now: NOW, requested: { ...parent, maximumPrivileges: ["fs.read", "fs.write"] } })
    );
    const grand = ok(
      narrowDefinition({
        parent: child,
        now: NOW,
        requested: {
          ...child,
          scope: [{ kind: "path", id: "/repo/acme/app/lib", coverage: "exact" }],
          maximumPrivileges: ["fs.read"]
        }
      })
    );
    expect(isSubset(grand, child, NOW)).toBe(true);
    expect(isSubset(grand, parent, NOW)).toBe(true);
    expect(isSubset(parent, grand, NOW)).toBe(false);
    expect(
      no(narrowDefinition({ parent: grand, now: NOW, requested: { ...grand, maximumPrivileges: ["fs.write"] } })).join()
    ).toMatch(/escalation:privilege fs.write/);
  });

  it("hashes definitions canonically", () => {
    expect(definitionHash({ ...parent, maximumPrivileges: [...parent.maximumPrivileges] })).toBe(
      definitionHash(parent)
    );
    expect(definitionHash({ ...parent, limits: { ...parent.limits, maxOperations: 19 } })).not.toBe(
      definitionHash(parent)
    );
  });
});
