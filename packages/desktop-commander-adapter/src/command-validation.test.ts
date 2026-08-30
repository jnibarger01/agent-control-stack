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

  it("rejects NUL bytes", () => {
    expect(() => validateProcessCommand("git\0status", roots)).toThrow(/NUL/);
  });
});
