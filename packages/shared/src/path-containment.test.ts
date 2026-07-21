import { describe, expect, it } from "vitest";
import { isPathContained } from "./path-containment.js";

describe("platform-aware path containment", () => {
  it("handles POSIX boundary prefixes without false containment", () => {
    expect(isPathContained("/srv/app", "/srv/app/src/index.ts", "posix")).toBe(true);
    expect(isPathContained("/srv/app", "/srv/application/config", "posix")).toBe(false);
    expect(isPathContained("/srv/app", "/srv/app/../secrets", "posix")).toBe(false);
  });

  it("handles Windows case, drive, traversal, and UNC vectors", () => {
    expect(isPathContained("C:\\Repo", "c:\\repo\\src\\index.ts", "win32")).toBe(true);
    expect(isPathContained("C:\\Repo", "C:\\Repository\\secret.txt", "win32")).toBe(false);
    expect(isPathContained("C:\\Repo", "C:\\Repo\\..\\Secrets", "win32")).toBe(false);
    expect(isPathContained("C:\\Repo", "D:\\Repo\\src", "win32")).toBe(false);
    expect(isPathContained("\\\\server\\share\\repo", "\\\\SERVER\\SHARE\\repo\\src", "win32")).toBe(true);
    expect(isPathContained("\\\\server\\share\\repo", "\\\\server\\share\\repository", "win32")).toBe(false);
  });
});
