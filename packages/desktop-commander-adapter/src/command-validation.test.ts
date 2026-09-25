import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateProcessCommand } from "./command-validation.js";

const roots = [realpathSync(tmpdir())];

describe("validateProcessCommand", () => {
  it("accepts a read-only diagnostic", () => {
    const result = validateProcessCommand("git status", roots);
    expect(result.executable).toBe("git");
    expect(result.risk).not.toBe("forbidden");
  });

  it("rejects shell metacharacters and redirection", () => {
    expect(() => validateProcessCommand("ls; rm -rf /", roots)).toThrow(/shell metacharacter/);
    expect(() => validateProcessCommand("cat /etc/passwd > /tmp/x", roots)).toThrow(/shell metacharacter/);
    expect(() => validateProcessCommand("echo $(whoami)", roots)).toThrow(/shell metacharacter/);
    expect(() => validateProcessCommand("a && b", roots)).toThrow(/shell metacharacter/);
    expect(() => validateProcessCommand("cat foo|grep x", roots)).toThrow(/shell metacharacter/);
  });

  it("rejects privilege escalation", () => {
    expect(() => validateProcessCommand("sudo apt install", roots)).toThrow(/privilege escalation/);
    expect(() => validateProcessCommand("doas whoami", roots)).toThrow(/privilege escalation/);
  });

  it("rejects shell wrappers as the executable", () => {
    expect(() => validateProcessCommand("bash -c evil", roots)).toThrow(/shell.*wrapper|metacharacter/);
    expect(() => validateProcessCommand("env FOO=bar cmd", roots)).toThrow(/shell.*wrapper|environment/);
  });

  it("rejects inline environment assignments", () => {
    expect(() => validateProcessCommand("FOO=bar npm test", roots)).toThrow(/environment assignment/);
  });

  it("rejects forbidden / destructive commands", () => {
    expect(() => validateProcessCommand("rm -rf /home", roots)).toThrow(/forbidden|destructive/);
    expect(() => validateProcessCommand("dd if=/dev/zero of=/dev/sda", roots)).toThrow(/forbidden|destructive/);
    expect(() => validateProcessCommand("chmod 777 /etc", roots)).toThrow(/forbidden|approval|destructive/);
  });

  it("rejects caller-supplied executable paths", () => {
    expect(() => validateProcessCommand("/tmp/evil/git status", roots)).toThrow(/executable paths are forbidden/);
  });

  it("rejects command-policy bypass flags", () => {
    expect(() => validateProcessCommand("git diff --no-index /etc/shadow /dev/null", roots)).toThrow(/dangerous command argument/);
    expect(() => validateProcessCommand("docker run --privileged alpine", roots)).toThrow(/dangerous command argument/);
    expect(() => validateProcessCommand("docker run -v /:/host alpine", roots)).toThrow(/dangerous command argument/);
  });

  it("contains path-bearing output flags", () => {
    expect(() => validateProcessCommand("git diff --output=/etc/acs-command-escape", roots)).toThrow(
      /forbidden by ACS policy.*--output/
    );
  });

  it("refuses git --output even inside an allow root, because it writes a file", () => {
    expect(() => validateProcessCommand(`git diff --output=${roots[0]}/diff.txt`, roots)).toThrow(/forbidden by ACS policy.*--output/);
  });

  it("does not inherit the machine controller's wider read-only rules", () => {
    for (const command of ["ls", "rg foo x", "grep foo x", "find .", "cat x"]) {
      expect(() => validateProcessCommand(command, roots)).toThrow(/forbidden by ACS policy/);
    }
  });

  it("resolves accepted executables from a fixed system path", () => {
    const result = validateProcessCommand("git status", roots);
    expect(result.resolvedExecutable).toMatch(/^\/(usr\/)?bin\/git$|^\/usr\/local\/bin\/git$/);
    expect(result.resolvedCommandLine).toContain("git status");
  });

  it("rejects NUL bytes", () => {
    expect(() => validateProcessCommand("git\0status", roots)).toThrow(/NUL/);
  });
});
