import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerOnce } from "./index.js";

// Opt-in end-to-end proof: ACS work item -> policy -> (approval) -> claim/lease
// -> execution authorization -> LOCAL Desktop Commander MCP -> bounded result
// -> immutable result -> canonical audit. Needs the local fork built.
const ENTRYPOINT = process.env.ACS_DC_ENTRYPOINT ?? "/home/jacen/projects/desktop-commander/dist/index.js";
const ENABLED = process.env.ACS_DC_LIVE_INTEGRATION === "1" && existsSync(ENTRYPOINT);

let dir: string;
let root: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-dc-e2e-"));
  root = realpathSync(dir);
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "readme.txt"), "END TO END EVIDENCE LINE\n");
  dbPath = join(dir, "control.db");
  vi.stubEnv("ACS_EXECUTION_BACKEND", "desktop_commander");
  vi.stubEnv("ACS_DESKTOP_COMMANDER_COMMAND", process.execPath);
  vi.stubEnv("ACS_DESKTOP_COMMANDER_ARGS_JSON", JSON.stringify([ENTRYPOINT]));
  vi.stubEnv("ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS", root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function seedApprovedRead(absPath: string): string {
  const store = new SqliteWorkItemStore(dbPath);
  const tools = createWorkItemTools(store, createPolicyEngine());
  try {
    return tools.create_work_item({
      title: "e2e: read a file via Desktop Commander",
      requester: "user",
      intent: "prove the real execution path",
      target: { cwd: "/repo" },
      requestedActions: [
        {
          kind: "fs.read",
          description: "read a file",
          params: { paths: ["src/index.ts"], tool: "read_file", arguments: { path: absPath } }
        }
      ],
      risk: "low"
    }).id;
  } finally {
    store.close();
  }
}

describe.skipIf(!ENABLED)("Desktop Commander live end-to-end", () => {
  it("runs the full ACS lifecycle against the real local Desktop Commander MCP", async () => {
    const id = seedApprovedRead(join(root, "pkg", "readme.txt"));

    const result = await runWorkerOnce({ dbPath, workerId: "e2e-worker" });
    console.log("[e2e] worker result:", JSON.stringify(result));

    expect(result).toMatchObject({ executed: true, executionMode: "desktop_commander", workItemId: id });

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.get(id)?.status).toBe("succeeded");

      const events = store.readEvents({ limit: 500 });
      const names = events.map((e) => e.name);
      const chain = [
        "policy.decided",
        "work_item.approved",
        "work_item.running",
        "execution.authorization_requested",
        "execution.authorization_granted",
        "execution.started",
        "desktop_commander.tool_called",
        "desktop_commander.tool_succeeded",
        "execution.result_persisted",
        "execution.completed",
        "work_item.succeeded"
      ];
      for (const name of chain) expect(names, name).toContain(name);
      console.log("[e2e] audit lifecycle:", chain.filter((n) => names.includes(n)).join(" -> "));
      expect(store.verifyAuditChain().ok).toBe(true);

      const resultRef = store.get(id)?.result as { resultId?: string };
      const stored = store.getExecutionResult(resultRef.resultId!);
      expect(stored?.simulationMetadata).toMatchObject({
        executionMode: "desktop_commander",
        simulated: false,
        backend: "desktop-commander-mcp",
        toolName: "read_file"
      });
      expect(stored?.stdout).toContain("END TO END EVIDENCE LINE");
      console.log("[e2e] immutable result simulationMetadata:", JSON.stringify(stored?.simulationMetadata));
      console.log(
        "[e2e] granted authorization event body:",
        JSON.stringify(events.find((e) => e.name === "execution.authorization_granted")?.body)
      );
    } finally {
      store.close();
    }
  }, 40_000);

  it("NEGATIVE: an unauthorized action (path escapes the allow root) never invokes Desktop Commander", async () => {
    const id = seedApprovedRead("/etc/passwd");

    const result = await runWorkerOnce({ dbPath, workerId: "e2e-worker" });
    console.log("[e2e-neg] worker result:", JSON.stringify(result));
    expect(result.executed).toBe(false);

    const store = new SqliteWorkItemStore(dbPath);
    try {
      const events = store.readEvents({ limit: 500 });
      const names = events.map((e) => e.name);
      expect(names).toContain("execution.authorization_denied");
      expect(names).not.toContain("desktop_commander.tool_called");
      expect(names).not.toContain("desktop_commander.tool_succeeded");
      expect(store.get(id)?.status).not.toBe("succeeded");
      expect(store.verifyAuditChain().ok).toBe(true);
      console.log(
        "[e2e-neg] denied event:",
        JSON.stringify(events.find((e) => e.name === "execution.authorization_denied")?.body)
      );
    } finally {
      store.close();
    }
  }, 40_000);
});
