import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { containJaceCommanderInvocation, validateJaceCommanderInvocation } from "./jace-commander.js";
import { jaceCommanderContainmentFromEnv } from "./config.js";

const temp = mkdtempSync(join(tmpdir(), "jc-split-acl-"));
const home = join(temp, "home");
const projects = join(home, "projects");
const outside = join(temp, "outside");
for (const dir of [home, projects, outside, join(home, ".ssh")]) mkdirSync(dir, { recursive: true });
for (const file of [join(home, "notes.txt"), join(projects, "project.txt"), join(outside, "outside.txt"), join(home, ".ssh", "id_rsa")]) writeFileSync(file, "ordinary text");
symlinkSync(outside, join(home, "escape"));
const config = jaceCommanderContainmentFromEnv({
  ACS_JACE_COMMANDER_ALLOWED_ROOTS: home,
  ACS_JACE_COMMANDER_WRITE_ROOTS: projects
});
if (!config) throw new Error("configuration must be present");
const check = (name: string, args: Record<string, unknown>) =>
  containJaceCommanderInvocation(validateJaceCommanderInvocation(name, args), config);

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("Jace Commander split read/write containment (ACS signing boundary)", () => {
  it("allows ordinary home reads and project mutations", () => {
    expect(() => check("read_file", { path: join(home, "notes.txt") })).not.toThrow();
    expect(() => check("write_file", { path: join(projects, "project.txt"), content: "ok" })).not.toThrow();
    expect(() => check("move_file", { from: join(projects, "project.txt"), to: join(projects, "new.txt") })).not.toThrow();
  });
  it("denies reads outside home, credentials and symlink escapes", () => {
    expect(() => check("read_file", { path: join(outside, "outside.txt") })).toThrow();
    expect(() => check("read_file", { path: join(home, ".ssh", "id_rsa") })).toThrow();
    expect(() => check("read_file", { path: join(home, "escape", "outside.txt") })).toThrow();
  });
  it("denies writes and source moves outside projects", () => {
    expect(() => check("write_file", { path: join(home, "notes.txt"), content: "x", overwrite: true })).toThrow();
    expect(() => check("move_file", { from: join(home, "notes.txt"), to: join(projects, "x") })).toThrow();
    expect(() => check("edit_block", { path: join(home, "notes.txt"), old: "text", new: "other" })).toThrow();
    expect(() => check("git_add", { repo: home, paths: ["notes.txt"] })).toThrow();
    expect(() => check("git_status", { repo: home })).toThrow();
  });
  it("fails closed for unrestricted execution even with cwd in projects", () => {
    expect(() => check("start_process", { argv: ["/usr/bin/node", "--version"], cwd: projects })).toThrow(/unavailable/);
    expect(() => check("privileged_exec", { argv: ["/usr/bin/id"] })).toThrow(/unavailable/);
  });
  it("rejects empty write roots instead of silently widening permissions", () => {
    expect(() => jaceCommanderContainmentFromEnv({
      ACS_JACE_COMMANDER_ALLOWED_ROOTS: home,
      ACS_JACE_COMMANDER_WRITE_ROOTS: ""
    })).toThrow();
  });
});
