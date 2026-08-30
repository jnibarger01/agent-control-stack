import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionActionHash } from "@agent-control-stack/work-items";
import type { DesktopCommanderAdapterConfig } from "./config.js";
import { authorizeDesktopCommanderExecution } from "./execution-authorization.js";
import { DesktopCommanderMachineExecutor } from "./machine-executor.js";
import { makeClaimed, makeLease, makeWorkItem } from "./test-fixtures.js";

// Opt-in only: needs the local Desktop Commander fork built at
// $ACS_DC_ENTRYPOINT (default /home/jacen/projects/desktop-commander/dist/index.js).
const ENTRYPOINT = process.env.ACS_DC_ENTRYPOINT ?? "/home/jacen/projects/desktop-commander/dist/index.js";
const ENABLED = process.env.ACS_DC_LIVE_INTEGRATION === "1" && existsSync(ENTRYPOINT);

let root: string;
let executor: DesktopCommanderMachineExecutor;

const containment = () => ({ allowedRoots: [root], deniedRoots: [] });

function config(): DesktopCommanderAdapterConfig {
  return {
    command: process.execPath,
    args: [ENTRYPOINT],
    allowedRoots: [root],
    deniedRoots: [],
    connectTimeoutMs: 20_000,
    requestTimeoutMs: 30_000,
    maxResultBytes: 256 * 1024
  };
}

function authFor(tool: string, args: Record<string, unknown>) {
  const workItem = makeWorkItem(root, {
    requestedActions: [{ kind: "fs.read", description: tool, params: { tool, arguments: args } }]
  });
  const claimed = makeClaimed(workItem, { actionHash: executionActionHash(workItem) });
  return authorizeDesktopCommanderExecution({
    claimed,
    trustedWorkItem: workItem,
    lease: makeLease(claimed),
    workerId: "worker_1",
    containment: containment(),
    requestId: `live_${tool}`,
    now: new Date()
  });
}

describe.skipIf(!ENABLED)("Desktop Commander live integration (harmless read-only ops)", () => {
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dc-live-")));
    writeFileSync(join(root, "hello.txt"), "live integration hello\n");
    executor = new DesktopCommanderMachineExecutor(config());
    const info = await executor.preflight();
    expect(info.toolCount).toBeGreaterThan(0);
  }, 30_000);

  afterAll(async () => {
    await executor?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("get_config", async () => {
    const result = await executor.execute({ authorization: authFor("get_config", {}) });
    expect(result.isError).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("list_directory of the contained root", async () => {
    const result = await executor.execute({ authorization: authFor("list_directory", { path: root }) });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("hello.txt");
  });

  it("read_file inside the contained root", async () => {
    const result = await executor.execute({
      authorization: authFor("read_file", { path: join(root, "hello.txt") })
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("live integration hello");
  });

  it("get_file_info inside the contained root", async () => {
    const result = await executor.execute({
      authorization: authFor("get_file_info", { path: join(root, "hello.txt") })
    });
    expect(result.isError).toBe(false);
  });
});
