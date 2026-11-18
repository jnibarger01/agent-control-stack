/**
 * Native Jace Commander executor lease: recognition and lease-holder binding.
 *
 * The installed JC release lives outside any ACS release tree at
 * ~/.local/lib/jace-commander/{current|releases/<id>}/dist/cli.js. Before this
 * contract existed ACS could not discover that process, so every lease check
 * failed closed with "no managed executor discovered". These tests pin:
 *
 *  - the installed JC runtime is recognized, and only through its release root;
 *  - a JC-written lease binds to the verified holder root, not just a PID;
 *  - stale, reused, forged, standalone and competing topologies still fail closed.
 */
import { describe, expect, it } from "vitest";
import {
  acsExecutorRoot,
  isManagedExecutorCommand,
  observeManagedAuthority,
  type AuthorityFiles,
  type AuthorityRuntime
} from "./managed-authority.js";

const NODE = "/usr/bin/node";
const JC_CURRENT_ROOT = "/home/jacen/.local/lib/jace-commander/current/";
const JC_PINNED_ROOT = "/home/jacen/.local/lib/jace-commander/releases/1.0.0-607128e5fee9/";
const DC_ROOT = "/home/jacen/releases/dc/3f274c0-monorepo/";
const JC_PID = 308090;
const BOOT_ID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const START_TICKS = "9182736";

const jcServe = `${NODE} ${JC_CURRENT_ROOT}dist/cli.js serve`;
const dcBridge = `${NODE} ${DC_ROOT}dist/index.js`;

function leaseJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    instanceId: "jc-test-instance-1",
    pid: JC_PID,
    acquiredAt: 1_000,
    renews: 2,
    expiresAt: 9_999_999_999_999,
    hostname: "cachyos-x8664",
    bootId: BOOT_ID,
    processStartTicks: START_TICKS,
    executorKind: "jace-commander",
    releaseRoot: JC_CURRENT_ROOT,
    releaseCommit: "607128e5fee9",
    ...overrides
  });
}

function files(leaseRaw: string | null = leaseJson()): AuthorityFiles {
  return { leaseExists: leaseRaw !== null, breakGlassExists: false, leaseRaw, breakGlassRaw: null };
}

function runtime(overrides: Partial<AuthorityRuntime> = {}): AuthorityRuntime {
  return {
    nowMs: 2_000,
    bootId: BOOT_ID,
    processStartTicks: START_TICKS,
    executionBackend: "desktop_commander",
    launchArgs: [],
    pidAlive: (pid) => pid === JC_PID,
    managedExecutorPids: [JC_PID],
    holderCommand: jcServe,
    competingExecutorRoots: [JC_CURRENT_ROOT],
    ...overrides
  };
}

describe("installed Jace Commander runtime is a managed executor", () => {
  it("recognizes the current symlinked release serving the bridge", () => {
    expect(isManagedExecutorCommand(jcServe)).toBe(true);
    expect(acsExecutorRoot(jcServe)).toBe(JC_CURRENT_ROOT.replace(/\/$/u, ""));
  });

  it("recognizes a pinned release directory", () => {
    const command = `${NODE} ${JC_PINNED_ROOT}dist/cli.js serve`;
    expect(acsExecutorRoot(command)).toBe(JC_PINNED_ROOT.replace(/\/$/u, ""));
  });

  it("rejects a jace-commander tree that is not an installed release", () => {
    expect(isManagedExecutorCommand(`${NODE} /home/jacen/src/jace-commander/dist/cli.js serve`)).toBe(false);
    expect(isManagedExecutorCommand(`${NODE} /home/jacen/.local/lib/jace-commander/evil/dist/cli.js serve`)).toBe(false);
  });

  it("rejects a dist/cli.js vendored under node_modules inside a release", () => {
    const vendored = `${NODE} ${JC_PINNED_ROOT}node_modules/left-pad/dist/cli.js serve`;
    expect(isManagedExecutorCommand(vendored)).toBe(false);
  });

  it("does not widen the generic cli.js rule to ACS release roots", () => {
    expect(isManagedExecutorCommand(`${NODE} /home/jacen/releases/acs/607128e5-x/dist/cli.js serve`)).toBe(false);
  });

  it("resolves traversal spellings before matching the release root", () => {
    const traversal = `${NODE} ${JC_CURRENT_ROOT}../../../../tmp/evil/dist/cli.js serve`;
    expect(isManagedExecutorCommand(traversal)).toBe(false);
  });
});

describe("Jace Commander lease holder binding", () => {
  it("is authoritative when the lease, holder process and root all agree", () => {
    const observed = observeManagedAuthority(files(), runtime());
    expect(observed.leaseActive).toBe(true);
    expect(observed.leaseAmbiguous).toBe(false);
    expect(observed.managedRuntime).toBe(true);
    expect(observed.authoritative).toBe(true);
    expect(observed.authorityOwner).toBe(`managed:pid:${JC_PID}`);
  });

  it("fails closed when the lease claims a root the holder process does not run from", () => {
    const observed = observeManagedAuthority(
      files(leaseJson({ releaseRoot: JC_PINNED_ROOT })),
      runtime()
    );
    expect(observed.leaseAmbiguous).toBe(true);
    expect(observed.authoritative).toBe(false);
    expect(observed.managedRuntime).toBe(false);
  });

  it("fails closed when a JC lease omits its release root", () => {
    const raw = JSON.parse(leaseJson()) as Record<string, unknown>;
    delete raw.releaseRoot;
    const observed = observeManagedAuthority(files(JSON.stringify(raw)), runtime());
    expect(observed.leaseAmbiguous).toBe(true);
    expect(observed.authoritative).toBe(false);
  });

  it("fails closed on PID reuse: the holder start ticks no longer match", () => {
    const observed = observeManagedAuthority(files(), runtime({ processStartTicks: "1" }));
    expect(observed.leaseAmbiguous).toBe(true);
    expect(observed.authoritative).toBe(false);
    expect(observed.detail).toContain("pid was reused");
  });

  it("fails closed when the boot id differs (lease from before a reboot)", () => {
    const observed = observeManagedAuthority(
      files(),
      runtime({ bootId: "ffffffff-ffff-4fff-8fff-ffffffffffff" })
    );
    expect(observed.leaseAmbiguous).toBe(true);
    expect(observed.authoritative).toBe(false);
  });

  it("is inactive, not ambiguous, when the recorded JC holder is dead", () => {
    const observed = observeManagedAuthority(files(), runtime({ pidAlive: () => false }));
    expect(observed.leaseActive).toBe(false);
    expect(observed.authoritative).toBe(false);
  });

  it("fails closed for a forged lease pointing at a live process that is not a managed executor", () => {
    const observed = observeManagedAuthority(
      files(leaseJson({ pid: 4242 })),
      runtime({ pidAlive: () => true, managedExecutorPids: [JC_PID], holderCommand: "/usr/bin/sleep 999" })
    );
    expect(observed.leaseAmbiguous).toBe(true);
    expect(observed.authoritative).toBe(false);
  });

  it("does not let a malformed lease gain authority", () => {
    const observed = observeManagedAuthority(files("{not json"), runtime());
    expect(observed.leaseAmbiguous).toBe(true);
    expect(observed.authoritative).toBe(false);
  });

  it("an expired TTL alone does not revoke a live, identity-matching holder", () => {
    const observed = observeManagedAuthority(
      files(leaseJson({ expiresAt: 1 })),
      runtime({ nowMs: 10_000_000 })
    );
    expect(observed.leaseActive).toBe(true);
    expect(observed.authoritative).toBe(true);
  });

  it("an empty discovery set cannot verify the holder, so the lease is not authoritative", () => {
    const observed = observeManagedAuthority(
      files(),
      runtime({ managedExecutorPids: [], competingExecutorRoots: [] })
    );
    expect(observed.authoritative).toBe(false);
    expect(observed.managedExecutorDiscovered).toBe(false);
  });
});

describe("standalone and competing topologies cannot gain managed authority", () => {
  it("a standalone launch never acquires managed runtime, even with a valid JC lease", () => {
    const observed = observeManagedAuthority(files(), runtime({ launchArgs: ["--standalone"] }));
    expect(observed.managedRuntime).toBe(false);
  });

  it("a standalone holder command is unmanaged even when the lease is valid", () => {
    const observed = observeManagedAuthority(
      files(),
      runtime({ holderCommand: `${NODE} ${JC_CURRENT_ROOT}dist/cli.js serve --standalone` })
    );
    expect(observed.managedRuntime).toBe(false);
  });

  it("a Desktop Commander root competing with the JC root is ambiguous, not silently authoritative", () => {
    const observed = observeManagedAuthority(
      files(),
      runtime({
        managedExecutorPids: [JC_PID, 555],
        competingExecutorRoots: [JC_CURRENT_ROOT.replace(/\/$/u, ""), DC_ROOT.replace(/\/$/u, "")]
      })
    );
    expect(observed.multipleAuthoritativeExecutors).toBe(true);
    expect(observed.authoritative).toBe(false);
  });

  it("the same JC release running several roles is one topology, not a competitor", () => {
    const observed = observeManagedAuthority(
      files(),
      runtime({
        managedExecutorPids: [JC_PID, 308076],
        competingExecutorRoots: [JC_CURRENT_ROOT.replace(/\/$/u, "")]
      })
    );
    expect(observed.multipleAuthoritativeExecutors).toBe(false);
    expect(observed.authoritative).toBe(true);
  });

  it("a DC-only lease keeps its existing semantics and is not reinterpreted as JC", () => {
    const dcLease = JSON.stringify({
      instanceId: "dc-1",
      pid: 777,
      expiresAt: 9_999_999_999_999,
      bootId: BOOT_ID,
      processStartTicks: START_TICKS
    });
    const observed = observeManagedAuthority(
      { leaseExists: true, breakGlassExists: false, leaseRaw: dcLease, breakGlassRaw: null },
      runtime({ pidAlive: (pid) => pid === 777, managedExecutorPids: [777], holderCommand: dcBridge, competingExecutorRoots: [DC_ROOT.replace(/\/$/u, "")] })
    );
    expect(observed.authoritative).toBe(true);
    expect(observed.managedRuntime).toBe(true);
  });
});
