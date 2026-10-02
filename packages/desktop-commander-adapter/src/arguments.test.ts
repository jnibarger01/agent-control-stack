import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  desktopCommanderInvocationFingerprint,
  normalizeInvocation,
  reconstructDesktopCommanderInvocation
} from "./arguments.js";
import type { ContainmentConfig } from "./containment.js";

let root: string;
let config: ContainmentConfig;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dc-args-")));
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "a.txt"), "a");
  config = { allowedRoots: [root], deniedRoots: [] };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("normalizeInvocation", () => {
  it("validates + canonicalises path args", () => {
    const norm = normalizeInvocation("read_file", { path: join(root, "pkg", "a.txt") }, config);
    expect(norm.toolName).toBe("read_file");
    expect(norm.validatedArguments.path).toBe(join(root, "pkg", "a.txt"));
    expect(norm.canonicalPaths).toContain(join(root, "pkg", "a.txt"));
  });

  it("rejects an unknown tool", () => {
    expect(() => normalizeInvocation("kill_process", { pid: 1 }, config)).toThrow(
      /not on the ACS Desktop Commander allowlist/
    );
  });

  it("rejects invalid arguments", () => {
    expect(() => normalizeInvocation("read_file", { path: 5 }, config)).toThrow(/invalid arguments/);
    expect(() => normalizeInvocation("read_file", { path: join(root, "pkg", "a.txt"), isUrl: true }, config)).toThrow(
      /invalid arguments/
    );
  });

  it("rejects a path outside the allow root", () => {
    expect(() => normalizeInvocation("read_file", { path: "/etc/passwd" }, config)).toThrow(/outside every allow root/);
  });

  it("validates the command line for start_process", () => {
    expect(() =>
      normalizeInvocation("start_process", { command: "rm -rf /", timeout_ms: 1000, cwd: root }, config)
    ).toThrow(/forbidden|destructive|metacharacter/);
    const ok = normalizeInvocation("start_process", { command: "git status", timeout_ms: 1000, cwd: root }, config);
    expect(ok.toolName).toBe("start_process");
    expect(ok.validatedArguments.cwd).toBe(root);
    expect(ok.canonicalPaths).toContain(root);
  });

  it("start_process rejects a caller-supplied shell", () => {
    expect(() =>
      normalizeInvocation(
        "start_process",
        { command: "git status", timeout_ms: 1000, cwd: root, shell: "/tmp/evil/sh" },
        config
      )
    ).toThrow(/invalid arguments/);
  });

  it("start_process rejects credential paths in command arguments", () => {
    expect(() =>
      normalizeInvocation("start_process", { command: "cat .ssh/id_rsa", timeout_ms: 1000, cwd: root }, config)
    ).toThrow(/forbidden|credential\/system path is denied/);
  });

  it("start_process requires an explicit contained cwd", () => {
    expect(() => normalizeInvocation("start_process", { command: "git status", timeout_ms: 1000 }, config)).toThrow(
      /invalid arguments/
    );
    expect(() =>
      normalizeInvocation("start_process", { command: "git status", timeout_ms: 1000, cwd: "/etc" }, config)
    ).toThrow(/outside every allow root/);
    expect(() =>
      normalizeInvocation(
        "start_process",
        { command: "git status", timeout_ms: 1000, cwd: join(root, "does-not-exist") },
        config
      )
    ).toThrow(/does not exist/);
  });

  it("changing any argument changes the fingerprint", () => {
    const a = normalizeInvocation("read_file", { path: join(root, "pkg", "a.txt") }, config);
    const b = normalizeInvocation("read_file", { path: join(root, "pkg", "a.txt"), length: 10 }, config);
    expect(desktopCommanderInvocationFingerprint(a)).not.toBe(desktopCommanderInvocationFingerprint(b));
  });

  it("fingerprint is stable regardless of key order", () => {
    const a = normalizeInvocation(
      "edit_block",
      {
        file_path: join(root, "pkg", "a.txt"),
        old_string: "a",
        new_string: "b"
      },
      config
    );
    const b = normalizeInvocation(
      "edit_block",
      {
        new_string: "b",
        old_string: "a",
        file_path: join(root, "pkg", "a.txt")
      },
      config
    );
    expect(desktopCommanderInvocationFingerprint(a)).toBe(desktopCommanderInvocationFingerprint(b));
  });
});

describe("project-scoped start_process ACS rules", () => {
  // A self-contained containment/projects root so this suite runs identically
  // on any host instead of depending on a personal checkout location.
  let projectsRepo: string;
  let projectContainment: ContainmentConfig;
  let insideTestFile: string;
  beforeAll(() => {
    projectsRepo = realpathSync(mkdtempSync(join(tmpdir(), "dc-projects-")));
    projectContainment = { allowedRoots: [projectsRepo], deniedRoots: [] };
    insideTestFile = join(projectsRepo, "packages/machine-controller/src/command.test.ts");
    mkdirSync(join(projectsRepo, "packages/machine-controller/src"), { recursive: true });
    writeFileSync(insideTestFile, "");
  });
  afterAll(() => rmSync(projectsRepo, { recursive: true, force: true }));

  it.each([
    () => `git -C ${projectsRepo} worktree list`,
    () => `git -C ${projectsRepo} worktree add ${join(projectsRepo, "new-worktree")} feature/test`,
    () => `npm --prefix ${projectsRepo} run check`,
    () => `npx --prefix ${projectsRepo} tsc -b`,
    () => `node ${insideTestFile}`
  ])("normalizes project process command for approval: %s", (commandLine) => {
    const invocation = normalizeInvocation(
      "start_process",
      { command: commandLine(), timeout_ms: 1000, cwd: projectsRepo },
      projectContainment
    );

    expect(invocation.policy.requiresApproval).toBe(true);
    expect(invocation.validatedArguments.command).toMatch(/^\/(usr\/)?bin\/(git|npm|npx|node) /);
  });

  it("keeps git project paths inside the ACS projects root", () => {
    expect(() =>
      normalizeInvocation(
        "start_process",
        { command: "git -C /tmp status", timeout_ms: 1000, cwd: projectsRepo },
        projectContainment
      )
    ).toThrow(/forbidden|outside every allow root/);
  });
});

describe("reconstructDesktopCommanderInvocation", () => {
  it("derives the invocation from a single requested action", () => {
    const norm = reconstructDesktopCommanderInvocation(
      {
        id: "wi_1",
        requestedActions: [
          {
            kind: "read_file",
            description: "read a file",
            params: { tool: "read_file", arguments: { path: join(root, "pkg", "a.txt") } }
          }
        ]
      },
      config
    );
    expect(norm.toolName).toBe("read_file");
  });

  it("fails closed when there is not exactly one action", () => {
    expect(() => reconstructDesktopCommanderInvocation({ id: "wi_2", requestedActions: [] }, config)).toThrow(
      /exactly one requested action/
    );
    expect(() =>
      reconstructDesktopCommanderInvocation(
        {
          id: "wi_3",
          requestedActions: [
            { kind: "read_file", description: "x", params: {} },
            { kind: "list_directory", description: "y", params: {} }
          ]
        },
        config
      )
    ).toThrow(/exactly one requested action/);
  });
});
