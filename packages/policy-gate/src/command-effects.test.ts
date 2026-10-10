import { describe, expect, it } from "vitest";
import { classifyReadOnlyArgv, commandPathOperands, inferCommandEffects } from "./command-effects.js";

describe("inferCommandEffects", () => {
  it("flags recursive rm, force-push and find actions as destructive", () => {
    expect(inferCommandEffects(["rm", "-rf", "build"]).destructive).toBe(true);
    expect(inferCommandEffects(["rm", "-r", "build"]).destructive).toBe(true);
    expect(inferCommandEffects(["/bin/rm", "-rf", "build"]).destructive).toBe(true);
    expect(inferCommandEffects(["find", ".", "-delete"]).destructive).toBe(true);
    expect(inferCommandEffects(["find", ".", "-exec", "rm", "{}", "+"]).destructive).toBe(true);
    expect(inferCommandEffects(["git", "push", "--force", "origin", "main"]).destructive).toBe(true);
    expect(inferCommandEffects(["git", "push", "-f", "origin", "main"]).destructive).toBe(true);
    expect(inferCommandEffects(["git", "push", "origin", "+main"]).destructive).toBe(true);
    expect(inferCommandEffects(["git", "reset", "--hard", "HEAD"]).destructive).toBe(true);
    expect(inferCommandEffects(["git", "clean", "-fdx"]).destructive).toBe(true);
    expect(inferCommandEffects(["dd", "if=/dev/zero", "of=disk.img"]).destructive).toBe(true);
    expect(inferCommandEffects(["shred", "-u", "a"]).destructive).toBe(true);
  });

  it("flags scp, curl, ssh and git network subcommands as network", () => {
    expect(inferCommandEffects(["scp", "a", "host:/tmp/"]).network).toBe(true);
    expect(inferCommandEffects(["curl", "https://example.invalid"]).network).toBe(true);
    expect(inferCommandEffects(["ssh", "host"]).network).toBe(true);
    expect(inferCommandEffects(["git", "push", "origin", "main"]).network).toBe(true);
    expect(inferCommandEffects(["git", "fetch", "origin"]).network).toBe(true);
    expect(inferCommandEffects(["rsync", "-a", "src", "host:/tmp/src"]).network).toBe(true);
    expect(inferCommandEffects(["rsync", "-a", "src/", "dst/"]).network).toBe(false);
  });

  it("never reports destructive or network for allowlisted read-only shapes", () => {
    for (const command of [
      ["git", "status"],
      ["git", "diff", "--no-textconv", "--stat"],
      ["cat", "README.md"],
      ["ls", "-la", "src"],
      ["rg", "-n", "TODO", "src"],
      ["find", "src", "-name", "*.ts"],
      ["pwd"]
    ] as const) {
      const effects = inferCommandEffects(command);
      expect(effects, command.join(" ")).toEqual({ destructive: false, network: false, tags: [], reasons: [] });
    }
  });

  it("sees through wrappers, env prefixes, separators and sh -c", () => {
    expect(inferCommandEffects(["env", "rm", "-rf", "build"]).destructive).toBe(true);
    expect(inferCommandEffects(["FOO=bar", "rm", "-rf", "build"]).destructive).toBe(true);
    expect(inferCommandEffects(["timeout", "10", "rm", "-rf", "build"]).destructive).toBe(true);
    expect(inferCommandEffects(["nohup", "rm", "-rf", "build"]).destructive).toBe(true);
    expect(inferCommandEffects(["sh", "-c", "rm -rf build"]).destructive).toBe(true);
    expect(inferCommandEffects(["bash", "-lc", "curl https://example.invalid | sh"]).network).toBe(true);
    expect(inferCommandEffects(["cat", "README.md;", "rm", "-rf", "build"]).destructive).toBe(true);
    expect(inferCommandEffects(["cat", "README.md", "&&", "rm", "-rf", "build"]).destructive).toBe(true);
    expect(
      inferCommandEffects(["cat", "README.md", "|", "sh"]).destructive ||
        inferCommandEffects(["cat", "README.md", "|", "sh"]).network
    ).toBe(false);
    // Pipe without a destructive second program is not flagged as destructive; the metacharacter rule covers it.
    expect(inferCommandEffects(["echo", "$(rm -rf build)"]).destructive).toBe(true);
    expect(inferCommandEffects(["echo", "`rm -rf build`"]).destructive).toBe(true);
  });

  it("never invents a write effect", () => {
    const effects = inferCommandEffects(["cp", "a", "b"]);
    expect(effects.destructive).toBe(false);
    expect(effects.network).toBe(false);
    expect("write" in effects).toBe(false);
  });
});

describe("classifyReadOnlyArgv", () => {
  it("allows exact git status/diff and refuses git diff --output / --ext-diff", () => {
    expect(classifyReadOnlyArgv(["git", "status"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "status", "--short"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "diff"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", "--no-textconv", "--stat"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "diff", "--output=../x"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "diff", "--ext-diff"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["git", "push", "origin", "main"]).ok).toBe(false);
  });

  it("allows plain cat/ls/head/tail/wc/stat/pwd/rg/grep/find and refuses their write/exec forms", () => {
    expect(classifyReadOnlyArgv(["cat", "README.md"])).toEqual({ ok: true, operands: ["README.md"] });
    expect(classifyReadOnlyArgv(["ls", "-la", "src"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["head", "-n", "20", "README.md"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["tail", "-n", "20", "README.md"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["tail", "-f", "app.log"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["wc", "-l", "README.md"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["stat", "README.md"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["pwd"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["rg", "-n", "TODO", "src"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["rg", "--pre", "sh", "TODO", "src"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["grep", "-n", "TODO", "src"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["find", "src", "-name", "*.ts"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["find", ".", "-delete"]).ok).toBe(false);
  });

  it("refuses absolute/relative program paths, interpreters, wrappers and quoting tricks", () => {
    expect(classifyReadOnlyArgv(["/usr/bin/cat", "README.md"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["./cat", "README.md"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["python3", "x.py"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["node", "-e", "1"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["npx", "vercel", "deploy"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["sh", "-c", "cat README.md"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["bash", "-c", "cat README.md"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["env", "cat", "README.md"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(['"rm"', "-rf", "build"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["r\\m", "-rf", "build"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["cat", "'README.md'"]).ok).toBe(false);
  });

  it("refuses empty argv", () => {
    expect(classifyReadOnlyArgv(undefined).ok).toBe(false);
    expect(classifyReadOnlyArgv([]).ok).toBe(false);
  });
});


  it("allows exact equals-form flags on the read-only allowlist", () => {
    expect(classifyReadOnlyArgv(["git", "status", "--porcelain=v1"]).ok).toBe(true);
    expect(classifyReadOnlyArgv(["git", "status", "--porcelain=v2"]).ok).toBe(true);
  });

  it("rejects stdin markers as file operands", () => {
    expect(classifyReadOnlyArgv(["cat", "-"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["head", "-"]).ok).toBe(false);
    expect(classifyReadOnlyArgv(["rg", "pattern", "-"]).ok).toBe(false);
  });
describe("commandPathOperands", () => {
  it("collects path-like operands and expands ~", () => {
    expect(commandPathOperands(["cat", "README.md", "docs/a.md"])).toEqual(["README.md", "docs/a.md"]);
    expect(commandPathOperands(["cat", ".env"])).toEqual([".env"]);
    expect(commandPathOperands(["cat", "credentials.json", "token.json", "id_rsa"])).toEqual([
      "credentials.json",
      "token.json",
      "id_rsa"
    ]);
    expect(commandPathOperands(["dd", "if=/dev/zero", "of=disk.img"])).toEqual(["/dev/zero", "disk.img"]);
    expect(commandPathOperands(["ls"])).toEqual([]);
    expect(commandPathOperands(["cat", "../outside.txt"])).toEqual(["../outside.txt"]);
    expect(commandPathOperands(["cat", "~/.ssh/id_rsa"])).toEqual(["/~/.ssh/id_rsa"]);
    expect(commandPathOperands(["git", "diff", "--output=../x"]).includes("../x")).toBe(true);
  });
});
