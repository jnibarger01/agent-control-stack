import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_CLI_CATALOG,
  AGENT_CLI_IDS,
  agentEnv,
  createDispatchWorktree,
  discoverRepos,
  inspectWorktree,
  parseVersion,
  planAgentCommand,
  probeAgentCli,
  resolveRepoRoot,
  runAgent,
  versionDrifted
} from "./index.js";

let dir: string;
let bin: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "acs-agent-cli-")));
  bin = join(dir, "bin");
  mkdirSync(bin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("catalog", () => {
  it("covers exactly the nine CLIs, each putting the prompt in its arguments", () => {
    expect([...AGENT_CLI_IDS].sort()).toEqual([
      "antigravity",
      "claude",
      "cline",
      "codex",
      "cursor-agent",
      "goose",
      "hermes",
      "openclaw",
      "opencode"
    ]);
    for (const id of AGENT_CLI_IDS) {
      const spec = AGENT_CLI_CATALOG[id];
      const args = spec.buildArgs({ prompt: "PROMPT-MARKER", mode: "edit", timeoutSec: 60, cwd: "/w/tree" });
      expect(args).toContain("PROMPT-MARKER");
      // The prompt is a single argv entry (no shell), so it cannot be split or interpreted.
      expect(args.filter((a) => a.includes("PROMPT-MARKER"))).toEqual(["PROMPT-MARKER"]);
    }
  });

  it("never enables a CLI's bypass-everything flags", () => {
    for (const id of AGENT_CLI_IDS) {
      for (const mode of ["edit", "read-only"] as const) {
        if (mode === "read-only" && !AGENT_CLI_CATALOG[id].readOnlySupported) continue;
        const args = AGENT_CLI_CATALOG[id].buildArgs({ prompt: "p", mode, timeoutSec: 60, cwd: "/w" });
        for (const banned of [
          "--yolo",
          "-y",
          "--force",
          "-f",
          "--auto",
          "bypassPermissions",
          "yolo",
          "--dangerously-skip-permissions"
        ]) {
          expect(args).not.toContain(banned);
        }
      }
    }
  });

  it("uses each CLI's own read-only mode and refuses where none is verified", () => {
    const ro = (id: (typeof AGENT_CLI_IDS)[number]) =>
      AGENT_CLI_CATALOG[id].buildArgs({ prompt: "p", mode: "read-only", timeoutSec: 60, cwd: "/w" });
    expect(ro("claude")).toContain("plan");
    expect(ro("codex")).toContain("read-only");
    expect(ro("antigravity")).toEqual(["--print", "p", "--mode", "plan"]);
    expect(ro("cursor-agent")).toContain("ask");
    expect(ro("cursor-agent")).toContain("--trust");
    expect(ro("cline")).toContain("--plan");
    for (const id of ["hermes", "openclaw", "goose"] as const) {
      expect(AGENT_CLI_CATALOG[id].readOnlySupported).toBe(false);
      expect(() => ro(id)).toThrow();
    }
  });
});

describe("environment", () => {
  it("drops ACS secrets and unrelated keys, keeps the CLI's own provider variables", () => {
    const source = {
      HOME: "/home/x",
      PATH: "/usr/bin",
      ACS_GATEWAY_TOKEN: "secret-a",
      GITHUB_TOKEN: "secret-b",
      OPENAI_API_KEY: "openai",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      XDG_CONFIG_HOME: "/home/x/.config"
    };
    const claude = agentEnv(AGENT_CLI_CATALOG.claude, source);
    expect(claude).toMatchObject({
      HOME: "/home/x",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      XDG_CONFIG_HOME: "/home/x/.config"
    });
    expect(claude).not.toHaveProperty("ACS_GATEWAY_TOKEN");
    expect(claude).not.toHaveProperty("GITHUB_TOKEN");
    expect(claude).not.toHaveProperty("OPENAI_API_KEY");
    expect(agentEnv(AGENT_CLI_CATALOG.codex, source)).toHaveProperty("OPENAI_API_KEY");
  });
});

describe("probe", () => {
  it("reports missing, installed, drifted and login state without reading login files", async () => {
    fake("codex", 'echo "codex-cli 0.159.2"');
    fake("claude", 'echo "9.0.1 (Claude Code)"');
    const home = join(dir, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const codex = await probeAgentCli(AGENT_CLI_CATALOG.codex, { pathValue: bin, home });
    expect(codex).toMatchObject({ installed: true, version: "0.159.2", versionDrift: false, loginDetected: true });
    const claude = await probeAgentCli(AGENT_CLI_CATALOG.claude, { pathValue: bin, home });
    expect(claude).toMatchObject({ installed: true, version: "9.0.1", versionDrift: true, loginDetected: false });
    const agy = await probeAgentCli(AGENT_CLI_CATALOG.antigravity, { pathValue: bin, home });
    expect(agy).toMatchObject({ installed: false, versionDrift: false });
    fake("agy", 'echo "1.2.13"');
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    expect(await probeAgentCli(AGENT_CLI_CATALOG.antigravity, { pathValue: bin, home })).toMatchObject({
      installed: true,
      version: "1.2.13",
      loginDetected: true
    });
  });

  it("parses versions and detects minor drift only", () => {
    expect(parseVersion("goose 1.45.0")).toBe("1.45.0");
    expect(parseVersion("no digits")).toBeUndefined();
    expect(versionDrifted("1.45.9", "1.45.0")).toBe(false);
    expect(versionDrifted("1.46.0", "1.45.0")).toBe(true);
  });
});

describe("planAgentCommand", () => {
  it("refuses CLIs whose dispatch is blocked, unless a connection test asks to try anyway", () => {
    fake("openclaw", "exit 0");
    const base = { agentId: "openclaw", prompt: "go", mode: "edit" as const, cwd: "/w", pathValue: bin };
    expect(() => planAgentCommand(base)).toThrow(/not dispatchable/);
    expect(planAgentCommand({ ...base, allowBlocked: true }).agentId).toBe("openclaw");
  });

  it("binds the confirmed command to a hash and rejects bad input", () => {
    fake("claude", "exit 0");
    const base = { agentId: "claude", prompt: "fix it", mode: "edit" as const, cwd: "/w", pathValue: bin };
    const a = planAgentCommand(base);
    expect(a.commandHash).toBe(planAgentCommand(base).commandHash);
    expect(planAgentCommand({ ...base, prompt: "fix it please" }).commandHash).not.toBe(a.commandHash);
    expect(planAgentCommand({ ...base, timeoutSec: 99_999 }).timeoutSec).toBe(3_600);
    expect(() => planAgentCommand({ ...base, agentId: "rm" })).toThrow(/unknown agent/);
    expect(() => planAgentCommand({ ...base, prompt: "  " })).toThrow(/prompt is required/);
    fake("hermes", "exit 0");
    expect(() => planAgentCommand({ ...base, agentId: "hermes", mode: "read-only" })).toThrow(/no verified read-only/);
    expect(() => planAgentCommand({ ...base, agentId: "cline" })).toThrow(/not found on PATH/);
  });
});

describe("runAgent", () => {
  const run = (
    script: string,
    over: Partial<Parameters<typeof planAgentCommand>[0]> = {},
    extra: Partial<Parameters<typeof runAgent>[0]> = {}
  ) => {
    fake("claude", script);
    const command = planAgentCommand({
      agentId: "claude",
      prompt: "go",
      mode: "edit",
      cwd: dir,
      pathValue: bin,
      timeoutSec: 10,
      ...over
    });
    return runAgent({ command, cwd: dir, ...extra });
  };

  it("captures output and exit status without a shell", async () => {
    const ok = await run('echo "hello $1"; echo "err" 1>&2');
    expect(ok).toMatchObject({ outcome: "succeeded", exitCode: 0 });
    expect(ok.output).toContain("hello -p");
    expect(ok.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await run("exit 3")).toMatchObject({ outcome: "failed", exitCode: 3 });
  });

  it("does not hand the agent ACS secrets", async () => {
    process.env.ACS_GATEWAY_TOKEN = "leak-check-value";
    try {
      const result = await run('echo "val=[${ACS_GATEWAY_TOKEN}]"');
      expect(result.output).toContain("val=[]");
    } finally {
      delete process.env.ACS_GATEWAY_TOKEN;
    }
  });

  it("strips terminal escape codes from output", async () => {
    const result = await run("printf '\\033[31mred\\033[0m plain\\n'");
    expect(result.output.trim()).toBe("red plain");
  });

  it("redacts only the offending line, not the whole transcript", async () => {
    const result = await run("echo useful progress; echo API_KEY=abc123def; echo done");
    expect(result.output).toContain("useful progress");
    expect(result.output).toContain("done");
    expect(result.output).not.toContain("abc123def");
  });

  it("redacts secret-shaped output and caps its size", async () => {
    const secret = ["sk", "ant", "api03", "A".repeat(40)].join("-");
    const result = await run(`echo ${secret}; yes x | head -c 5000`, {}, { maxOutputBytes: 1_000 });
    expect(result.output).not.toContain(secret);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(1_100);
  });

  it("kills the whole process group on timeout and on cancel", async () => {
    const timed = await run("sleep 30 & wait", { timeoutSec: 10 }, {});
    expect(timed.outcome).toBe("timed_out");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const cancelled = await run("sleep 30", {}, { signal: controller.signal });
    expect(cancelled.outcome).toBe("cancelled");
  }, 30_000);
});

describe("worktrees", () => {
  function repo(): string {
    const root = join(dir, "repo");
    mkdirSync(root);
    const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.test");
    g("config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    return realpathSync(root);
  }

  it("only resolves repositories inside the allow-list", async () => {
    const root = repo();
    expect(await resolveRepoRoot(root, [dir])).toBe(root);
    await expect(resolveRepoRoot(root, [])).rejects.toThrow(/outside ACS_AGENT_REPO_ROOTS/);
    await expect(resolveRepoRoot("relative/path", [dir])).rejects.toThrow(/absolute/);
    await expect(resolveRepoRoot(join(dir, "nope"), [dir])).rejects.toThrow(/does not exist/);
    mkdirSync(join(dir, "plain"));
    await expect(resolveRepoRoot(join(dir, "plain"), [dir])).rejects.toThrow(/not a git repository/);
  });

  it("suggests repositories under the allowed roots without following hidden or dependency folders", () => {
    const root = repo();
    mkdirSync(join(dir, "projects", "alpha", ".git"), { recursive: true });
    mkdirSync(join(dir, "projects", ".hidden", ".git"), { recursive: true });
    mkdirSync(join(dir, "projects", "node_modules", ".git"), { recursive: true });
    mkdirSync(join(dir, "projects", "plain"), { recursive: true });
    expect(discoverRepos([join(dir, "projects")]).map((p) => p.split("/").pop())).toEqual(["alpha"]);
    expect(discoverRepos([dir])).toContain(root);
    expect(discoverRepos([join(dir, "missing")])).toEqual([]);
  });

  it("gives each run its own branch and reports what the agent changed", async () => {
    const root = repo();
    const wt = await createDispatchWorktree({
      repoRoot: root,
      runId: "run1",
      agentId: "claude",
      worktreeRoot: join(dir, "wts")
    });
    expect(wt.branch).toBe("acs/agent/claude-run1");
    expect(wt.worktreePath.startsWith(realpathSync(join(dir, "wts")))).toBe(true);
    writeFileSync(join(wt.worktreePath, "a.txt"), "two\n");
    writeFileSync(join(wt.worktreePath, "new.txt"), "x\n");
    const changes = await inspectWorktree(wt);
    expect(changes.changedFiles.sort()).toEqual(["a.txt", "new.txt"]);
    expect(changes.commitsAhead).toBe(0);
    // The main checkout is untouched.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).toBe("");
    await expect(createDispatchWorktree({ repoRoot: root, runId: "../evil", agentId: "claude" })).rejects.toThrow(
      /simple identifiers/
    );
  });
});
