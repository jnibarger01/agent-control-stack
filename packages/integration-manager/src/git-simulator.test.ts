import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MergeSimulator, createGitRunner, createIsolatedClone } from "./git-simulator.js";
import { Scratch, git } from "./fixtures.test-support.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function scratch() {
  const s = new Scratch();
  cleanups.push(() => s.dispose());
  return s;
}

describe("MergeSimulator", () => {
  it("reports a clean merge and the resulting tree", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n", "b.txt": "b\n" });
    const head = s.branch("feature", base, { "a.txt": "a changed\n" });
    const sim = new MergeSimulator(createGitRunner(s.dir));
    expect(await sim.simulate(base, head)).toMatchObject({ evaluated: true, clean: true, conflicts: [], behindBy: 0 });
  });

  it("reports conflicting paths, sorted, without throwing", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
    const head = s.branch("feature", base, { "b.txt": "from feature\n", "a.txt": "feature a\n" });
    const main = s.advanceMain({ "b.txt": "from main\n", "a.txt": "main a\n" });
    const sim = new MergeSimulator(createGitRunner(s.dir));
    expect(await sim.simulate(main, head)).toMatchObject({
      evaluated: true,
      clean: false,
      conflicts: ["a.txt", "b.txt"],
      behindBy: 1
    });
  });

  it("counts how far the base has moved since the head diverged", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const head = s.branch("feature", base, { "z.txt": "z\n" });
    s.advanceMain({ "x.txt": "1\n" });
    const main = s.advanceMain({ "y.txt": "2\n" });
    const sim = new MergeSimulator(createGitRunner(s.dir));
    const result = await sim.simulate(main, head);
    expect(result).toMatchObject({ clean: true, behindBy: 2 });
  });

  it("fails closed on a commit that is not present or not a full id", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const sim = new MergeSimulator(createGitRunner(s.dir));
    expect(await sim.simulate(base, "f".repeat(40))).toMatchObject({ evaluated: false, clean: false });
    expect(await sim.simulate(base, "main")).toMatchObject({
      evaluated: false,
      clean: false,
      detail: "not a full commit id"
    });
    expect(await sim.simulate(base, "--output=/tmp/x")).toMatchObject({ evaluated: false });
  });

  it("leaves refs, the index and the working tree exactly as they were", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const head = s.branch("feature", base, { "a.txt": "feature\n" });
    const main = s.advanceMain({ "a.txt": "main\n" });
    const refsBefore = s.refs();
    const sim = new MergeSimulator(createGitRunner(s.dir));
    await sim.simulate(main, head);
    const tree = (await sim.simulate(base, head)).tree!;
    await sim.syntheticMerge(tree, [base, head]);
    expect(s.refs()).toBe(refsBefore);
    expect(s.status()).toBe("");
    expect(git(s.dir, "rev-parse", "HEAD")).toBe(main);
  });

  it("builds simulated merge commits without any host git identity or global config", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const one = s.branch("one", base, { "a.txt": "one\n" });
    const empty = mkdtempSync(join(tmpdir(), "acs-nohome-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const saved = {
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      XDG: process.env.XDG_CONFIG_HOME
    };
    process.env.HOME = empty;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.XDG_CONFIG_HOME = empty;
    try {
      const sim = new MergeSimulator(createGitRunner(s.dir));
      const merged = await sim.simulate(base, one);
      const commit = await sim.syntheticMerge(merged.tree!, [base, one]);
      expect(commit).toMatch(/^[0-9a-f]{40}$/u);
      // Deterministic: the same inputs give the same synthetic commit.
      expect(await sim.syntheticMerge(merged.tree!, [base, one])).toBe(commit);
    } finally {
      for (const [key, value] of [
        ["HOME", saved.HOME],
        ["GIT_CONFIG_GLOBAL", saved.GIT_CONFIG_GLOBAL],
        ["XDG_CONFIG_HOME", saved.XDG]
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("chains a simulated merge so the next pull request sees the first", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const one = s.branch("one", base, { "a.txt": "one\n" });
    const two = s.branch("two", base, { "a.txt": "two\n" });
    const sim = new MergeSimulator(createGitRunner(s.dir));
    const first = await sim.simulate(base, one);
    const tip = (await sim.syntheticMerge(first.tree!, [base, one]))!;
    expect(await sim.simulate(base, two)).toMatchObject({ clean: true });
    expect(await sim.simulate(tip, two)).toMatchObject({ evaluated: true, clean: false, conflicts: ["a.txt"] });
  });
});

describe("createIsolatedClone", () => {
  it("copies the refs so work in the clone cannot move the source", async () => {
    const s = scratch();
    const base = s.commit("base", { "a.txt": "a\n" });
    const head = s.branch("feature", base, { "a.txt": "feature\n" });
    const target = join(mkdtempSync(join(tmpdir(), "acs-clone-")), "sim.git");
    cleanups.push(() => rmSync(join(target, ".."), { recursive: true, force: true }));
    const refsBefore = s.refs();
    const runner = await createIsolatedClone(s.dir, target);
    const sim = new MergeSimulator(runner);
    expect(await sim.resolveCommit("refs/heads/main")).toBe(base);
    const result = await sim.simulate(base, head);
    await sim.syntheticMerge(result.tree!, [base, head]);
    expect(s.refs()).toBe(refsBefore);
    expect(s.status()).toBe("");
  });

  it("refuses when the source cannot be cloned", async () => {
    await expect(createIsolatedClone("/nonexistent/source/repo", join(tmpdir(), "acs-never"))).rejects.toThrow(
      /isolated clone failed/
    );
  });
});
