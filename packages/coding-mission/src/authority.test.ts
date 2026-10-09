import { describe, expect, it } from "vitest";
import {
  envelopeHash,
  isSubsetOf,
  narrowAuthority,
  normalizeResource,
  resourceCovered,
  validateEnvelope,
  type AuthorityEnvelope
} from "./authority.js";

const NOW = "2026-10-09T00:00:00.000Z";
const LATER = "2026-10-09T01:00:00.000Z";
const parent: AuthorityEnvelope = {
  actions: ["fs.read", "fs.write", "shell.exec", "privileged_exec"],
  resources: ["repo/acme/app", "repo/acme/docs"],
  tools: ["read_file", "write_file", "start_process"],
  expiresAt: LATER
};

const deny = (result: ReturnType<typeof narrowAuthority>) => {
  if (result.ok) throw new Error("expected denial");
  return result.reasons;
};
const allow = (result: ReturnType<typeof narrowAuthority>) => {
  if (!result.ok) throw new Error(`expected narrowing, got ${result.reasons.join(",")}`);
  return result.envelope;
};

describe("resource scopes", () => {
  it("normalizes safe paths and refuses traversal, wildcards, backslashes and empties", () => {
    expect(normalizeResource("repo//acme/app/")).toBe("repo/acme/app");
    expect(normalizeResource("/abs/path")).toBe("/abs/path");
    for (const bad of ["", "/", "repo/../etc", "repo/./x", "repo/*", "a\\b", "repo/\0x", "x".repeat(600)]) {
      expect(normalizeResource(bad)).toBeUndefined();
    }
  });

  it("covers by whole path segment, not by string prefix", () => {
    expect(resourceCovered("repo/acme", "repo/acme")).toBe(true);
    expect(resourceCovered("repo/acme", "repo/acme/app/src")).toBe(true);
    expect(resourceCovered("repo/acme", "repo/acme-evil")).toBe(false);
    expect(resourceCovered("repo/acme/app", "repo/acme")).toBe(false);
  });
});

describe("narrowAuthority: child ⊆ parent", () => {
  it("inherits a non-privileged subset by default and strips privileged actions", () => {
    const child = allow(narrowAuthority({ parent, now: NOW }));
    expect(child.actions).toEqual(["fs.read", "fs.write", "shell.exec"]);
    expect(child.actions).not.toContain("privileged_exec");
    expect(isSubsetOf(child, parent)).toBe(true);
  });

  it("grants exactly the requested subset", () => {
    const child = allow(
      narrowAuthority({
        parent,
        now: NOW,
        requested: { actions: ["fs.read"], resources: ["repo/acme/app/src"], tools: ["read_file"] }
      })
    );
    expect(child).toMatchObject({ actions: ["fs.read"], resources: ["repo/acme/app/src"], tools: ["read_file"] });
    expect(isSubsetOf(child, parent)).toBe(true);
  });

  it("denies an escalation attempt with the reasons instead of silently clipping it", () => {
    const reasons = deny(
      narrowAuthority({
        parent,
        now: NOW,
        requested: {
          actions: ["fs.read", "net.fetch"],
          resources: ["repo/acme/app", "repo/other", "repo/acme-evil"],
          tools: ["read_file", "kill_process"]
        }
      })
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        "action_not_in_parent:net.fetch",
        "resource_not_in_parent:repo/other",
        "resource_not_in_parent:repo/acme-evil",
        "tool_not_in_parent:kill_process"
      ])
    );
  });

  it("denies privileged_exec when the parent lacks it", () => {
    const unprivileged = { ...parent, actions: ["fs.read"] };
    expect(
      deny(narrowAuthority({ parent: unprivileged, now: NOW, requested: { actions: ["privileged_exec"] } }))
    ).toContain("action_not_in_parent:privileged_exec");
  });

  it("keeps privileged actions out of children unless mission policy explicitly allows them AND the parent holds them", () => {
    expect(deny(narrowAuthority({ parent, now: NOW, requested: { actions: ["privileged_exec"] } }))).toContain(
      "privileged_child_not_allowed:privileged_exec"
    );
    const allowed = allow(
      narrowAuthority({
        parent,
        now: NOW,
        policy: { allowPrivilegedChildren: true },
        requested: { actions: ["privileged_exec"] }
      })
    );
    expect(allowed.actions).toEqual(["privileged_exec"]);
    expect(allow(narrowAuthority({ parent, now: NOW, policy: { allowPrivilegedChildren: true } })).actions).toContain(
      "privileged_exec"
    );
  });

  it("applies mission policy denials to both requests and inheritance", () => {
    const policy = { deniedActions: ["shell.exec"] };
    expect(allow(narrowAuthority({ parent, now: NOW, policy })).actions).not.toContain("shell.exec");
    expect(deny(narrowAuthority({ parent, now: NOW, policy, requested: { actions: ["shell.exec"] } }))).toContain(
      "action_denied_by_mission_policy:shell.exec"
    );
  });

  it("never lets a child outlive its parent and bounds it by policy TTL", () => {
    expect(deny(narrowAuthority({ parent, now: NOW, requested: { expiresAt: "2026-10-09T05:00:00.000Z" } }))).toContain(
      "expiry_exceeds_parent"
    );
    expect(
      allow(narrowAuthority({ parent, now: NOW, requested: { expiresAt: "2026-10-09T00:30:00.000Z" } })).expiresAt
    ).toBe("2026-10-09T00:30:00.000Z");
    expect(allow(narrowAuthority({ parent, now: NOW, policy: { maxChildTtlMs: 60_000 } })).expiresAt).toBe(
      "2026-10-09T00:01:00.000Z"
    );
  });

  it("fails when the parent authority has expired", () => {
    expect(deny(narrowAuthority({ parent: { ...parent, expiresAt: NOW }, now: NOW }))).toEqual(["authority_expired"]);
    expect(deny(narrowAuthority({ parent: { ...parent, expiresAt: "2020-01-01T00:00:00Z" }, now: NOW }))).toEqual([
      "authority_expired"
    ]);
  });

  it("rejects wildcards and malformed names outright", () => {
    for (const bad of ["*", "fs.*", "FS.READ", "", "a b"]) {
      expect(deny(narrowAuthority({ parent, now: NOW, requested: { actions: [bad] } })).length).toBeGreaterThan(0);
    }
    expect(deny(narrowAuthority({ parent, now: NOW, requested: { resources: ["repo/acme/*"] } }))).toContain(
      "resource_invalid:repo/acme/*"
    );
  });

  it("restricts and narrows worker identity", () => {
    const bound = { ...parent, workers: ["w1", "w2"] };
    expect(allow(narrowAuthority({ parent: bound, now: NOW })).workers).toEqual(["w1", "w2"]);
    expect(allow(narrowAuthority({ parent: bound, now: NOW, requested: { workers: ["w2"] } })).workers).toEqual(["w2"]);
    expect(deny(narrowAuthority({ parent: bound, now: NOW, requested: { workers: ["w3"] } }))).toContain(
      "worker_not_in_parent:w3"
    );
    // A child of an unbound parent may bind itself to a worker.
    expect(allow(narrowAuthority({ parent, now: NOW, requested: { workers: ["w9"] } })).workers).toEqual(["w9"]);
  });

  it("denies a request that leaves nothing", () => {
    const readOnly = { ...parent, actions: ["privileged_exec"] };
    expect(deny(narrowAuthority({ parent: readOnly, now: NOW }))).toContain("no_authority_remains");
  });

  it("is idempotent under repeated narrowing (a grandchild is a subset of its parent and of the root)", () => {
    const child = allow(
      narrowAuthority({
        parent,
        now: NOW,
        requested: { actions: ["fs.read", "fs.write"], resources: ["repo/acme/app"] }
      })
    );
    const grandchild = allow(
      narrowAuthority({
        parent: child,
        now: NOW,
        requested: { actions: ["fs.read"], resources: ["repo/acme/app/src"] }
      })
    );
    expect(isSubsetOf(grandchild, child)).toBe(true);
    expect(isSubsetOf(grandchild, parent)).toBe(true);
    expect(isSubsetOf(parent, grandchild)).toBe(false);
    expect(deny(narrowAuthority({ parent: grandchild, now: NOW, requested: { actions: ["fs.write"] } }))).toContain(
      "action_not_in_parent:fs.write"
    );
  });

  it("hashes envelopes canonically", () => {
    const reordered = { ...parent, actions: [...parent.actions].reverse(), resources: [...parent.resources].reverse() };
    expect(envelopeHash(reordered)).toBe(envelopeHash(parent));
    expect(envelopeHash({ ...parent, tools: ["read_file"] })).not.toBe(envelopeHash(parent));
  });

  it("validates envelopes", () => {
    expect(validateEnvelope(parent)).toEqual([]);
    expect(validateEnvelope({ ...parent, actions: [] })).toContain("actions_empty");
    expect(validateEnvelope({ ...parent, expiresAt: "soon" })).toContain("expiry_invalid");
  });
});
