import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewCommand } from "./command.js";
import type { MachineControllerConfig } from "./config.js";

const allCommands = [
  "git",
  "bun",
  "node",
  "python3",
  "df",
  "free",
  "docker",
  "ls",
  "wc",
  "head",
  "tail",
  "rg",
  "grep",
  "find",
  "du",
  "ps",
  "ss",
  "uname",
  "uptime",
  "whoami",
  "id",
  "hostname",
  "systemctl",
  "journalctl",
  "which"
];

describe("read-only command rules", () => {
  let root: string;
  let outside: string;
  let config: MachineControllerConfig;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "acs-readonly-rules-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "acs-readonly-outside-")));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "src", "a.txt"), "hello\n");
    writeFileSync(join(root, ".env"), "TOKEN=abc\n");
    writeFileSync(join(outside, "secret.txt"), "nope\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "escape.txt"));
    config = {
      server: { name: "test", transport: "stdio", version: "0.1.0" },
      security: {
        defaultPolicy: "deny",
        requireApprovalForMutations: true,
        redactSecrets: true,
        maxOutputBytes: 20_000,
        commandTimeoutMs: 1_000,
        commandTerminationGraceMs: 100
      },
      paths: { allow: [root], deny: [join(root, "private")] },
      commands: { allowReadonly: allCommands, deny: [], allowedUnits: ["acs-worker.service"] },
      audit: { logPath: join(root, "audit.jsonl") }
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const risk = (command: string, args: string[], cwd = root) => previewCommand(config, { cwd, command, args }).risk;

  it.each<[string, string[]]>([
    ["ls", []],
    ["ls", ["-la", "src"]],
    ["wc", ["-l", "src/a.txt"]],
    ["head", ["-n", "5", "src/a.txt"]],
    ["tail", ["-n", "20", "src/a.txt"]],
    ["rg", ["-n", "hello", "src/a.txt"]],
    ["rg", ["-e", "-dash-pattern", "src/a.txt"]],
    ["grep", ["-in", "hello", "src/a.txt"]],
    ["find", ["src", "-name", "*.txt", "-type", "f"]],
    ["find", ["src", "-maxdepth", "1"]],
    ["du", ["-sh", "src"]],
    ["ps", ["-eo", "pid,ppid,user,etime,comm"]],
    ["ss", ["-ltn"]],
    ["uname", ["-a"]],
    ["uptime", []],
    ["whoami", []],
    ["hostname", []],
    ["systemctl", ["status", "--no-pager", "acs-worker.service"]],
    ["systemctl", ["list-timers", "--all"]],
    ["journalctl", ["-u", "acs-worker.service", "-n", "100", "--no-pager"]],
    ["git", ["status"]],
    ["git", ["rev-parse", "--abbrev-ref", "HEAD"]],
    ["git", ["branch", "-vv"]],
    ["git", ["remote", "-v"]],
    ["git", ["describe", "--tags", "--always"]],
    ["git", ["blame", "-L", "1,5", "src/a.txt"]],
    ["git", ["ls-files", "src"]],
    ["docker", ["images"]],
    ["docker", ["logs", "--tail", "50", "acs-gateway"]],
    ["docker", ["stats", "--no-stream"]],
    ["which", ["git"]]
  ])("allows %s %j", (command, args) => {
    expect(risk(command, args)).toBe("read_only");
  });

  it.each<[string, string[], string]>([
    ["find", ["src", "-exec", "cat", "{}", ";"], "executes a program"],
    ["find", ["src", "-delete"], "deletes files"],
    ["find", ["src", "-fprint", "out"], "writes a file"],
    ["find", ["src", "-name", "x", "constructor", "y"], "prototype key as predicate"],
    ["find", [], "cwd traversal would enter a denied root"],
    ["find", ["."], "start path contains a denied root"],
    ["du", ["-sh"], "cwd traversal would enter a denied root"],
    ["ls", ["-R"], "recursive listing"],
    ["ls", ["private"], "denied path"],
    ["ls", [".."], "outside allow roots"],
    ["rg", ["--pre", "sh", "x", "src/a.txt"], "preprocessor executes a program"],
    ["rg", ["-f", "patterns", "src/a.txt"], "pattern file"],
    ["rg", ["-z", "x", "src/a.txt"], "decompressor"],
    ["rg", ["-L", "x", "src/a.txt"], "follows symlinks"],
    ["rg", ["TOKEN", "."], "directory search can read credential files"],
    ["rg", ["TOKEN", ".env"], "credential-like file"],
    ["rg", ["nope", "src/escape.txt"], "symlink out of the allow roots"],
    ["rg", ["hello"], "no path would search cwd recursively"],
    ["grep", ["-r", "TOKEN", "."], "recursive grep"],
    ["grep", ["-R", "TOKEN", "src"], "recursive grep following symlinks"],
    ["head", ["-n", "-5", "src/a.txt"], "negative count"],
    ["head", ["src"], "directory, not a file"],
    ["tail", ["-f", "src/a.txt"], "never exits"],
    ["tail", ["-F", "src/a.txt"], "never exits"],
    ["wc", [], "reads stdin"],
    ["ps", ["aux"], "exposes argv"],
    ["ps", ["-eo", "pid,args"], "exposes argv"],
    ["ps", ["-eo", "pid,cmd"], "exposes argv"],
    ["ss", ["-K"], "kills sockets"],
    ["uname", ["-a", "-r"], "extra args"],
    ["hostname", ["evil"], "sets the hostname"],
    ["id", ["root"], "unexpected args"],
    ["systemctl", ["status", "sshd.service"], "unit not allowlisted"],
    ["systemctl", ["list-timers", "sshd*"], "positional pattern"],
    ["journalctl", ["-u", "acs-worker.service"], "unbounded without -n"],
    ["journalctl", ["-n", "10"], "no unit"],
    ["journalctl", ["-u", "acs-worker.service", "-n", "10", "-f"], "follows forever"],
    ["journalctl", ["-u", "sshd.service", "-n", "10"], "unit not allowlisted"],
    ["git", ["diff", "--output=out.patch"], "writes a file"],
    ["git", ["log", "--output", "out.patch"], "writes a file"],
    ["git", ["diff", "--ext-diff"], "runs a configured program"],
    ["git", ["branch", "new-branch"], "creates a branch"],
    ["git", ["branch", "-D", "main"], "deletes a branch"],
    ["git", ["remote", "add", "x", "y"], "adds a remote"],
    ["git", ["describe", "--dirty"], "refreshes the index"],
    ["git", ["blame", "src"], "directory, not a file"],
    ["git", ["config", "user.name"], "unlisted subcommand"],
    ["git", ["-c", "core.pager=sh", "status"], "config injection"],
    ["docker", ["logs", "acs-gateway"], "unbounded without --tail"],
    ["docker", ["logs", "-f", "--tail", "10", "acs-gateway"], "follows forever"],
    ["docker", ["stats"], "streams forever"],
    ["docker", ["inspect", "acs-gateway"], "exposes container env"],
    ["which", ["-a", "git"], "unexpected flag"],
    ["node", ["--version", "-e", "1"], "evaluates code"],
    ["cat", ["src/a.txt"], "no rule; fs.read covers this"]
  ])("refuses %s %j (%s)", (command, args) => {
    expect(risk(command, args)).toBe("forbidden");
  });

  it("leaves mutations to the existing approval classification", () => {
    expect(risk("systemctl", ["restart", "acs-worker.service"])).toBe("requires_approval");
  });

  it("refuses rule-covered commands that are not in allow_readonly", () => {
    config.commands.allowReadonly = ["git"];
    expect(risk("ls", [])).toBe("forbidden");
  });

  it("never resolves prototype members as rules", () => {
    config.commands.allowReadonly = ["toString", "constructor", "__proto__"];
    for (const command of config.commands.allowReadonly) {
      expect(risk(command, [])).toBe("forbidden");
    }
  });

  it("refuses unit inspection when allowed_units is unset", () => {
    delete config.commands.allowedUnits;
    expect(risk("systemctl", ["status", "acs-worker.service"])).toBe("forbidden");
  });

  it("rewrites path arguments to their canonical real path", () => {
    const preview = previewCommand(config, { cwd: root, command: "head", args: ["-n", "1", "./src/../src/a.txt"] });
    expect(preview.args).toEqual(["-n", "1", join(root, "src", "a.txt")]);
  });

  it("does not rewrite search patterns as paths", () => {
    const preview = previewCommand(config, { cwd: root, command: "rg", args: ["src", "src/a.txt"] });
    expect(preview.args).toEqual(["src", join(root, "src", "a.txt")]);
  });

  it("reports why a command was refused", () => {
    expect(previewCommand(config, { cwd: root, command: "find", args: ["src", "-delete"] }).reason).toMatch(
      /predicate not allowed: -delete/
    );
  });
});
