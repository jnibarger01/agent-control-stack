import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Syscall-count guard for the evidence read-surface walk.
 *
 * `search_workspace` used to `statSync` every entry it visited — including plain
 * directories, whose kind the readdir dirent already reports. `list_directory` used to
 * re-resolve the workspace root with `realpathSync` once per entry. Both are wasted
 * blocking syscalls proportional to the number of entries in the workspace, so this
 * suite pins the syscall count to the number of entries that actually need it.
 *
 * The node:fs mock delegates to the real implementation; it only counts calls.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    realpathSync: vi.fn(actual.realpathSync)
  };
});

import { EvidenceReader, type EvidenceStoreReader } from "./reader.js";

const DIR_COUNT = 10;
const ROOT_FILE_COUNT = 10;

const fakeStore: EvidenceStoreReader = {
  getWorkItemSummary: () => ({ id: "wrk_1" }),
  getAttemptSummary: () => ({ attemptId: "attempt_1" }),
  getWorkspaceAllocationSummary: () => ({ allocationId: "workspace_1" }),
  getValidationRunSummary: () => ({ passed: true }),
  getExecutionPlanSummary: () => ({ planHash: "a".repeat(64) }),
  getExecutionSummary: () => ({ outcome: "succeeded" }),
  getSandboxSummary: () => ({ profile: "desktop_commander" }),
  getPolicyDecisions: () => [],
  getApprovalSummary: () => ({ approved: false }),
  getAuditExcerpt: () => [],
  getEvidenceManifest: () => ({ manifestHash: "b".repeat(64) })
};

const statCalls = (): string[] => vi.mocked(statSync).mock.calls.map((call) => String(call[0]));

describe("evidence read-surface walk — syscall volume", () => {
  let dir: string;
  let reader: EvidenceReader;
  let plainDirectories: string[];
  let symlinkedDirectory: string;
  /**
   * Entries that genuinely need a stat: root files, the symlinked directory, the
   * symlinked file, one file per real directory, and the file reached through the
   * symlinked directory.
   */
  const expectedStatCalls = ROOT_FILE_COUNT + 1 + 1 + DIR_COUNT + 1;

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "acs-ereader-walk-")));
    plainDirectories = [];
    for (let index = 0; index < DIR_COUNT; index += 1) {
      const name = `d${String(index).padStart(2, "0")}`;
      plainDirectories.push(join(dir, name));
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "f.txt"), `needle-in-dir ${index}\n`);
    }
    for (let index = 0; index < ROOT_FILE_COUNT; index += 1) {
      writeFileSync(join(dir, `n${String(index).padStart(2, "0")}.txt`), `needle-at-root ${index}\n`);
    }
    symlinkedDirectory = join(dir, "d00-link");
    symlinkSync(join(dir, "d00"), symlinkedDirectory, "dir");
    symlinkSync(join(dir, "n00.txt"), join(dir, "file-link.txt"));

    reader = new EvidenceReader({
      workItemId: "wrk_1",
      attemptId: "attempt_1",
      workspaceHostPath: dir,
      store: fakeStore
    });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("search_workspace stats entries that need it, not every directory it walks", async () => {
    vi.mocked(statSync).mockClear();
    const result = (await reader.search_workspace({ query: "no-such-token-anywhere" })) as {
      matches: unknown[];
    };
    expect(result.matches).toEqual([]);

    const statted = statCalls();
    expect(statted).toHaveLength(expectedStatCalls);
    // No plain directory should ever be statted during the walk.
    for (const plain of plainDirectories) expect(statted).not.toContain(plain);
  });

  it("search_workspace still traverses symlinked directories and statted symlinked files", async () => {
    const viaDirectory = (await reader.search_workspace({ query: "needle-in-dir" })) as {
      matches: Array<{ path: string }>;
    };
    const paths = viaDirectory.matches.map((match) => match.path);
    expect(paths).toContain("d00/f.txt");
    expect(paths).toContain("d00-link/f.txt");
    expect(paths).toHaveLength(DIR_COUNT + 1);
    // Name-sorted walk order: "d00" < "d00-link" < "d01" (as readdirSync().sort() produced).
    expect(paths).toEqual([
      "d00/f.txt",
      "d00-link/f.txt",
      ...Array.from({ length: DIR_COUNT - 1 }, (_unused, index) => `d${String(index + 1).padStart(2, "0")}/f.txt`)
    ]);

    const viaFile = (await reader.search_workspace({ query: "needle-at-root 0" })) as {
      matches: Array<{ path: string }>;
    };
    expect(viaFile.matches.map((match) => match.path)).toEqual(["file-link.txt", "n00.txt"]);
  });

  it("list_directory resolves the workspace root once per call, not once per entry", async () => {
    vi.mocked(realpathSync).mockClear();
    const listing = (await reader.list_directory({ path: "." })) as { entries: Array<{ path: string }> };
    expect(listing.entries.length).toBeGreaterThanOrEqual(ROOT_FILE_COUNT + DIR_COUNT);
    // containWithin resolves the requested path (and its canonical parent) — never one
    // realpath per listed entry.
    expect(vi.mocked(realpathSync).mock.calls.length).toBeLessThanOrEqual(3);
    expect(listing.entries.map((entry) => entry.path)).toContain("d00-link");
  });
});
