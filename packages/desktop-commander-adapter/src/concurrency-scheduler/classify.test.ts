import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedInvocation } from "../arguments.js";
import { desktopCommanderToolPolicy } from "../tool-policy.js";
import { classifyDesktopCommanderExecution } from "./classify.js";
import { resourceClaimsConflict } from "./locks.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function fixture(toolName: string, args: Record<string, unknown>, paths: string[]): NormalizedInvocation {
  const policy = desktopCommanderToolPolicy(toolName);
  if (!policy) throw new Error(`missing test policy for ${toolName}`);
  return {
    toolName,
    validatedArguments: args,
    policy,
    canonicalPaths: paths
  };
}
function makeRepo(): { root: string; file: string; secondFile: string } {
  const root = mkdtempSync(join(tmpdir(), "acs-exec-scheduler-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  const file = join(root, "src", "a.ts");
  const secondFile = join(root, "src", "b.ts");
  writeFileSync(file, "a");
  writeFileSync(secondFile, "b");
  return { root, file, secondFile };
}

describe("classifyDesktopCommanderExecution", () => {
  it("adds a shared repository claim to file reads", () => {
    const repo = makeRepo();
    const result = classifyDesktopCommanderExecution({
      requestId: "req-read",
      agentId: "claude",
      sessionId: "session-1",
      invocation: fixture("read_file", { path: repo.file }, [repo.file])
    });
    expect(result.lane).toBe("read");
    expect(result.resources).toContainEqual({
      key: `repo:${repo.root}`,
      mode: "shared"
    });
    expect(result.resources).toContainEqual({
      key: `file:${repo.file}`,
      mode: "shared"
    });
  });

  it("keeps unrelated file mutations concurrent while sharing a repo fence", () => {
    const repo = makeRepo();
    const first = classifyDesktopCommanderExecution({
      requestId: "req-a",
      agentId: "claude",
      sessionId: "session-1",
      invocation: fixture(
        "write_file",
        { path: repo.file, content: "a" },
        [repo.file]
      )
    });
    const second = classifyDesktopCommanderExecution({
      requestId: "req-b",
      agentId: "grok",
      sessionId: "session-2",
      invocation: fixture(
        "write_file",
        { path: repo.secondFile, content: "b" },
        [repo.secondFile]
      )
    });
    expect(first.resources).toContainEqual({
      key: `repo:${repo.root}`,
      mode: "shared"
    });
    expect(second.resources).toContainEqual({
      key: `repo:${repo.root}`,
      mode: "shared"
    });
    expect(first.resources).toContainEqual({
      key: `file:${repo.file}`,
      mode: "exclusive"
    });
    expect(second.resources).toContainEqual({
      key: `file:${repo.secondFile}`,
      mode: "exclusive"
    });
  });

  it("does not discover a repository root outside the ACS containment boundary", () => {
    const outer = makeRepo();
    const contained = join(outer.root, "contained");
    mkdirSync(contained);
    const file = join(contained, "inside.ts");
    writeFileSync(file, "inside");

    const result = classifyDesktopCommanderExecution({
      requestId: "req-contained",
      agentId: "claude",
      sessionId: "session-contained",
      invocation: fixture("read_file", { path: file }, [file]),
      containment: { allowedRoots: [contained] }
    });

    expect(result.resources).toContainEqual({
      key: `file:${file}`,
      mode: "shared"
    });
    expect(result.resources.some((claim) => claim.key === `repo:${outer.root}`)).toBe(false);
  });

  it("classifies git checkout as an exclusive repository mutation", () => {
    const repo = makeRepo();
    const result = classifyDesktopCommanderExecution({
      requestId: "req-git",
      agentId: "chatgpt",
      sessionId: "session-3",
      invocation: fixture(
        "start_process",
        { command: "/usr/bin/git checkout feature", cwd: repo.root, timeout_ms: 1000 },
        [repo.root]
      )
    });
    expect(result.lane).toBe("mutation");
    expect(result.effects).toBe("workspace_mutation");
    expect(result.resources).toContainEqual({
      key: `repo:${repo.root}`,
      mode: "exclusive"
    });

    const read = classifyDesktopCommanderExecution({
      requestId: "req-read-during-git",
      agentId: "claude",
      sessionId: "session-read",
      invocation: fixture("read_file", { path: repo.file }, [repo.file])
    });
    expect(resourceClaimsConflict(result.resources, read.resources)).toBe(true);
  });

  it("classifies test commands as bounded process work with an exclusive repo fence", () => {
    const repo = makeRepo();
    const result = classifyDesktopCommanderExecution({
      requestId: "req-test",
      agentId: "hermes",
      sessionId: "session-4",
      invocation: fixture(
        "start_process",
        { command: "/usr/bin/npm test", cwd: repo.root, timeout_ms: 1000 },
        [repo.root]
      )
    });
    expect(result.lane).toBe("process");
    expect(result.resources).toContainEqual({
      key: `repo:${repo.root}`,
      mode: "exclusive"
    });
  });
});
