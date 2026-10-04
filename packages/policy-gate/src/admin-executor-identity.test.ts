/**
 * Executor discovery and ambiguity semantics.
 *
 * Two properties are pinned here:
 *
 *  1. Discovery is anchored to ACS-owned executor roots. OpenClaw and claude-acp
 *     both expose a dist/index.js; a bare suffix match let them into the managed
 *     set and manufactured false ambiguity that denied admin mode outright.
 *
 *  2. Ambiguity means COMPETING executor topologies, not a process count. One
 *     ACS release legitimately runs several roles - control plane, Jace Commander
 *     bridge, remote - which all share a release root. Those must NOT be ambiguous.
 *     Ambiguity is reserved for distinct ACS roots (genuinely competing
 *     executors) and for stale/reused lease identity, which still fails closed.
 */
import { describe, expect, it } from "vitest";
import {
  acsExecutorRoot,
  isManagedExecutorCommand,
  observeManagedAuthority,
  type AuthorityFiles,
  type AuthorityRuntime
} from "./managed-authority.js";

const DC_RELEASE = "/home/jacen/releases/dc/3f274c0-monorepo";
const STALE_RELEASE = "/home/jacen/releases/dc/006e3db-integrity";
const NODE = "/home/jacen/releases/_node/v24.18.0/bin/node";

const controlPlane = `${NODE} ${DC_RELEASE}/dist/index.js`;
const jcBridge = `${NODE} ${DC_RELEASE}/dist/jace-commander/cli.js serve`;
const remoteManaged = `${NODE} ${DC_RELEASE}/dist/index.js remote --managed`;
const openclaw =
  "/home/linuxbrew/.linuxbrew/bin/node /home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist/index.js";
const claudeAcp =
  "/home/linuxbrew/.linuxbrew/bin/node /home/jacen/.local/share/zed/external_agents/registry/npx/claude-acp/node_modules/@agentclient/dist/index.js";

function lease(overrides: Record<string, unknown> = {}): AuthorityFiles {
  return {
    leaseRaw: JSON.stringify({
      pid: 7014,
      expiresAt: Date.now() + 60_000,
      instanceId: "executor-7014-1",
      bootId: "boot-1",
      processStartTicks: "100",
      ...overrides
    }),
    breakGlassRaw: null,
    leaseExists: true,
    breakGlassExists: false
  };
}

function runtime(overrides: Partial<AuthorityRuntime> = {}): AuthorityRuntime {
  return {
    nowMs: Date.now(),
    bootId: "boot-1",
    processStartTicks: "100",
    executionBackend: "desktop_commander",
    launchArgs: [],
    pidAlive: () => true,
    managedExecutorPids: [7014],
    competingExecutorRoots: [`${DC_RELEASE}/`],
    holderCommand: controlPlane,
    ...overrides
  };
}

describe("executor discovery is scoped to ACS-owned roots", () => {
  it("recognizes the real ACS executor shapes", () => {
    expect(isManagedExecutorCommand(controlPlane)).toBe(true);
    expect(isManagedExecutorCommand(jcBridge)).toBe(true);
    expect(isManagedExecutorCommand(remoteManaged)).toBe(true);
    expect(
      isManagedExecutorCommand(
        `${NODE} /home/jacen/projects/agent-control-stack/packages/desktop-commander/dist/index.js`
      )
    ).toBe(true);
  });

  it("never matches unrelated processes that expose a dist/index.js", () => {
    // Regression: a bare "dist/index.js" substring matched both of these and put
    // OpenClaw / claude-acp into the managed-executor set.
    expect(isManagedExecutorCommand(openclaw)).toBe(false);
    expect(isManagedExecutorCommand(claudeAcp)).toBe(false);
    expect(acsExecutorRoot(openclaw)).toBeUndefined();
    expect(acsExecutorRoot(claudeAcp)).toBeUndefined();
  });

  it("does not match unrelated or empty commands", () => {
    expect(isManagedExecutorCommand("/usr/bin/bash -c some-unrelated-command")).toBe(false);
    expect(isManagedExecutorCommand("")).toBe(false);
  });

  it("does not treat vendored packages as ACS executors", () => {
    // OpenClaw and claude-acp ship the SAME dist/index.js shape but live under
    // node_modules. Anchoring on script shape alone would pull both into the managed
    // set and manufacture false ambiguity on any developer machine.
    const vendored = [
      "/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist/index.js",
      "/home/jacen/.local/share/zed/external_agents/registry/npx/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
      "/releases/dc/3f274c0-monorepo/node_modules/some-dep/dist/index.js"
    ];
    for (const command of vendored) {
      expect(isManagedExecutorCommand(command), command).toBe(false);
    }
  });

  it("does not match unrelated binaries", () => {
    for (const command of ["/opt/google/chrome/chrome", "/usr/local/lib/ollama/ollama", "/usr/bin/node"]) {
      expect(isManagedExecutorCommand(command), command).toBe(false);
    }
  });

  it("a traversal-spelled competing root cannot hide behind a known prefix", () => {
    // Regression: taking the FIRST unnormalized match let a second executor written
    // as "<known-root>/../../evil/dist/index.js" collapse onto the known root and go
    // uncounted. The last match is resolved, so the identity compared is the real one.
    const traversal = `${DC_RELEASE}/../../evil-release/dist/index.js`;
    expect(acsExecutorRoot(traversal)).not.toBe(acsExecutorRoot(controlPlane));
    expect(acsExecutorRoot(traversal)).toContain("evil-release");
  });

  it("resolves the root it reports rather than echoing the raw match", () => {
    // "/./" and redundant separators normalize away, so the same release always
    // yields the same identity regardless of how the path was spelled.
    expect(acsExecutorRoot(`${DC_RELEASE}/./dist/index.js`)).toBe(acsExecutorRoot(controlPlane));
    expect(acsExecutorRoot(`${DC_RELEASE}//dist/index.js`)).toBe(acsExecutorRoot(controlPlane));
  });
});

describe("ambiguity is competing topologies, not process count", () => {
  it("the normal DC control-plane + JC bridge + remote topology is NOT ambiguous", () => {
    const observation = observeManagedAuthority(
      lease(),
      runtime({
        managedExecutorPids: [7014, 7020, 8842],
        competingExecutorRoots: [`${DC_RELEASE}/`]
      })
    );
    expect(observation.multipleAuthoritativeExecutors).toBe(false);
    expect(observation.leaseAmbiguous).toBe(false);
    expect(observation.leaseActive).toBe(true);
    expect(observation.authoritative).toBe(true);
    expect(observation.managedRuntime).toBe(true);
  });

  it("two genuinely competing ACS executor roots fail with executor ambiguity", () => {
    const observation = observeManagedAuthority(
      lease(),
      runtime({
        managedExecutorPids: [7014, 5569],
        competingExecutorRoots: [`${DC_RELEASE}/`, `${STALE_RELEASE}/`]
      })
    );
    expect(observation.multipleAuthoritativeExecutors).toBe(true);
    expect(observation.leaseAmbiguous).toBe(true);
    expect(observation.authoritative).toBe(false);
    expect(observation.managedRuntime).toBe(false);
    expect(observation.detail).toContain("competing managed executor topologies");
  });

  it("a stale lease boot id still fails closed", () => {
    const observation = observeManagedAuthority(lease({ bootId: "boot-from-another-boot" }), runtime());
    expect(observation.leaseActive).toBe(false);
    expect(observation.leaseAmbiguous).toBe(true);
    expect(observation.detail).toContain("boot id does not match");
  });

  it("a reused lease holder pid still fails closed", () => {
    // Holder pid is alive but its process start ticks differ from the recorded
    // ones: the pid was recycled, so the lease no longer identifies its owner.
    const observation = observeManagedAuthority(lease(), runtime({ processStartTicks: "999" }));
    expect(observation.leaseActive).toBe(false);
    expect(observation.leaseAmbiguous).toBe(true);
    expect(observation.detail).toContain("pid was reused");
  });

  it("a malformed or incomplete lease still fails closed", () => {
    expect(observeManagedAuthority({ ...lease(), leaseRaw: "{not json" }, runtime()).leaseAmbiguous).toBe(true);
    expect(
      observeManagedAuthority({ ...lease(), leaseRaw: JSON.stringify({ pid: 7014 }) }, runtime()).leaseAmbiguous
    ).toBe(true);
  });

  it("a dead lease holder is inactive, not ambiguous", () => {
    const observation = observeManagedAuthority(lease(), runtime({ pidAlive: () => false }));
    expect(observation.leaseActive).toBe(false);
    expect(observation.leaseAmbiguous).toBe(false);
  });

  it("an empty discovery set fails closed rather than skipping identity verification", () => {
    // Regression: classifyLease only checks the holder when managedExecutorPids is
    // non-empty, so "found nothing" used to mean "nothing to verify" - the original
    // defect. No discovered executor now means the holder cannot be identified.
    const observation = observeManagedAuthority(lease(), runtime({ managedExecutorPids: [] }));
    expect(observation.leaseAmbiguous).toBe(true);
    expect(observation.authoritative).toBe(false);
    expect(observation.managedRuntime).toBe(false);
    expect(observation.detail).toContain("no managed executor discovered");
  });

  it("falls back to a process count when no root analysis is supplied", () => {
    // Never silently suppress ambiguity: with no competingExecutorRoots the
    // previous conservative behaviour still applies.
    const observation = observeManagedAuthority(
      lease(),
      runtime({ managedExecutorPids: [1, 2], competingExecutorRoots: undefined })
    );
    expect(observation.multipleAuthoritativeExecutors).toBe(true);
    expect(observation.leaseAmbiguous).toBe(true);
  });
});