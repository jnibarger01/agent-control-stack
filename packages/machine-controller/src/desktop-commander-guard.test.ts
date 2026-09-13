import { describe, expect, it } from "vitest";
import { isDesktopCommanderBypassAttempt } from "./desktop-commander-guard.js";

describe("ADR-0016 Slice 5: cmd.run Desktop Commander bypass guard", () => {
  it("blocks the bare executable name", () => {
    expect(isDesktopCommanderBypassAttempt("desktop-commander", [])).toBe(true);
  });

  it("blocks npx invoking the scoped package, with or without a version", () => {
    expect(isDesktopCommanderBypassAttempt("npx", ["@wonderwhy-er/desktop-commander"])).toBe(true);
    expect(isDesktopCommanderBypassAttempt("npx", ["@wonderwhy-er/desktop-commander@latest"])).toBe(true);
    expect(isDesktopCommanderBypassAttempt("npx", ["-y", "@wonderwhy-er/desktop-commander@1.2.3"])).toBe(true);
  });

  it("blocks a direct path to a Desktop Commander build via node", () => {
    expect(
      isDesktopCommanderBypassAttempt("node", ["/home/jacen/projects/desktop-commander/dist/index.js"])
    ).toBe(true);
    expect(isDesktopCommanderBypassAttempt("node", ["./desktop-commander/dist/index.js"])).toBe(true);
  });

  it("blocks the executable named with a version suffix", () => {
    expect(isDesktopCommanderBypassAttempt("desktop-commander@2.0.0", [])).toBe(true);
  });

  it("blocks a Windows-style path segment", () => {
    expect(isDesktopCommanderBypassAttempt("node", ["C:\\tools\\desktop-commander\\dist\\index.js"])).toBe(true);
  });

  it("does not flag unrelated node/npm/npx commands", () => {
    expect(isDesktopCommanderBypassAttempt("node", ["--version"])).toBe(false);
    expect(isDesktopCommanderBypassAttempt("npx", ["-y", "cowsay", "hello"])).toBe(false);
    expect(isDesktopCommanderBypassAttempt("npm", ["run", "build"])).toBe(false);
    expect(isDesktopCommanderBypassAttempt("git", ["status"])).toBe(false);
  });

  it("does not flag a token that merely contains the substring without a real boundary", () => {
    // "my-desktop-commander-notes" is not the package or a path segment for it.
    expect(isDesktopCommanderBypassAttempt("cat", ["my-desktop-commander-notes.txt"])).toBe(false);
  });
});
