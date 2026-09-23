import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAcsCli } from "./dispatch.js";

const previousDb = process.env.ACS_DB_PATH;

afterEach(() => {
  if (previousDb === undefined) delete process.env.ACS_DB_PATH;
  else process.env.ACS_DB_PATH = previousDb;
});

describe("acs mode", () => {
  it("reports strict by default and persists an explicit admin switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-mode-cli-"));
    const dbPath = join(dir, "control.db");
    process.env.ACS_DB_PATH = dbPath;
    const io = {
      stdout: {
        chunks: "" as string,
        write(chunk: string) {
          this.chunks += chunk;
        }
      },
      stderr: { write() {} }
    };
    try {
      expect(await runAcsCli(["mode", "status"], io)).toBe(0);
      expect(io.stdout.chunks).toContain("Execution mode: strict");
      expect(io.stdout.chunks).toContain("Approval policy: policy");
      io.stdout.chunks = "";
      expect(await runAcsCli(["mode", "admin"], io)).toBe(0);
      expect(io.stdout.chunks).toContain("Execution mode: admin");
      expect(io.stdout.chunks).toContain("Approval policy: auto");
      io.stdout.chunks = "";
      expect(await runAcsCli(["mode", "status"], io)).toBe(0);
      expect(io.stdout.chunks).toContain("Execution mode: admin");
      io.stdout.chunks = "";
      expect(await runAcsCli(["mode", "strict"], io)).toBe(0);
      expect(io.stdout.chunks).toContain("Execution mode: strict");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
