import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DcLaneExecutionAdapter,
  type DcToolInvocation,
  type DcToolInvoker,
  type DcToolOutcome
} from "./dc-lane-adapter.js";
import { dcArgumentsHash } from "./dc-tool-call.js";
import type { BoundaryAuthority } from "./execution-boundary.js";
import { cleanupWorlds, world, type Options } from "./general-coding-fixture.js";
import type { ExecutionClaim, WorkUnitExecutorAdapter } from "./worker-execution.js";

afterEach(() => {
  vi.useRealTimers();
  cleanupWorlds();
});

type DcOptions = Pick<Options, "toolClasses" | "scope" | "privileges" | "expiresInMs" | "maxRuntimeMs"> & {
  toolName?: string;
  args?: (repository: string) => Record<string, unknown>;
  payload?: Record<string, unknown>;
};

/** A DC world: one `tool` unit on the dc lane, with the repository directory present on disk. */
function dcWorld(over: DcOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "acs-dc-"));
  const repository = join(root, "repos", "acs");
  mkdirSync(repository, { recursive: true });
  writeFileSync(join(repository, "README.md"), "hello");
  const toolName = over.toolName ?? "read_file";
  const args = (over.args ?? ((repo: string) => ({ path: join(repo, "README.md") })))(repository);
  const payload = {
    kind: "tool",
    toolName,
    arguments: args,
    argsHash: dcArgumentsHash(toolName, args),
    maxRuntimeMs: 30_000,
    ...over.payload
  };
  const w = world({
    root,
    lane: "dc",
    unit: { kind: "tool", payload },
    toolClasses: over.toolClasses ?? [{ runtime: "desktop_commander", toolName }],
    ...(over.scope ? { scope: over.scope } : {}),
    ...(over.privileges ? { privileges: over.privileges } : {}),
    ...(over.expiresInMs ? { expiresInMs: over.expiresInMs } : {}),
    ...(over.maxRuntimeMs !== undefined ? { maxRuntimeMs: over.maxRuntimeMs } : {})
  });
  const calls: DcToolInvocation[] = [];
  const invoker = (behavior: (call: DcToolInvocation) => Promise<DcToolOutcome> | DcToolOutcome): DcToolInvoker => ({
    async invoke(call) {
      calls.push(call);
      return behavior(call);
    }
  });
  const good = (): DcToolOutcome => ({ status: "succeeded", resultHash: "dc-result-1" });
  const dcAdapter = (inv: DcToolInvoker, authority: BoundaryAuthority = w.exec.authority) =>
    new DcLaneExecutionAdapter(w.exec.missions, authority, inv, () => w.state.now);
  return { ...w, repository, args, calls, invoker, good, dcAdapter };
}

/**
 * A gate that passes the real dispatch verification but reports an authority holding exactly `toolClasses`, so a test can
 * prove the adapter's own tool-class check rather than relying on the dispatch gate having refused first.
 */
function withToolClasses(
  real: BoundaryAuthority,
  toolClasses: ReadonlyArray<{ runtime: string; toolName: string }>
): BoundaryAuthority {
  return {
    verifyDispatch: (input) => real.verifyDispatch(input),
    unitAuthority: (...args) => real.unitAuthority(...args),
    missionAuthority: (id) => {
      const record = real.missionAuthority(id);
      return record
        ? { ...record, definition: { ...record.definition, toolClasses: [...toolClasses] as never } }
        : record;
    }
  } as BoundaryAuthority;
}

describe("DcLaneExecutionAdapter", () => {
  it("runs a validated read-only call and completes the unit with an empty file list", async () => {
    const w = dcWorld();
    const outcome = await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
    expect(outcome.status).toBe("executed");
    expect(w.unit().status).toBe("succeeded");
    expect(w.unit().resultHash).toBe("dc-result-1");
    expect(w.unit().files).toEqual([]);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.toolName).toBe("read_file");
    expect(w.calls[0]!.arguments).toEqual(w.args);
    expect(w.calls[0]!.claimToken).toBeTruthy();
  });

  describe("tool-name authority", () => {
    it("refuses a tool the Desktop Commander manifest does not manage", async () => {
      const w = dcWorld({ toolName: "format_disk", args: () => ({}) });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("tool_not_supported");
    });

    it.each(["write_file", "edit_block", "move_file", "create_directory", "start_process"])(
      "refuses %s: approval-bound tools are outside this lane's read-only slice",
      async (toolName) => {
        const w = dcWorld({ toolName, args: () => ({}) });
        await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
        expect(w.calls).toHaveLength(0);
        expect(w.attempt().report?.failure?.nativeCode).toBe("tool_not_supported");
      }
    );

    it("refuses a granted runtime that does not name this exact tool", async () => {
      const w = dcWorld();
      const gate = withToolClasses(w.exec.authority, [{ runtime: "desktop_commander", toolName: "list_directory" }]);
      await w.run([
        w.dcAdapter(
          w.invoker(() => w.good()),
          gate
        )
      ]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("tool_not_permitted");
    });

    it("refuses a manifest read-only tool this lane cannot scope-check", async () => {
      // get_config is read-only in the manifest but is not on the lane's allowlist, so its paths cannot be enumerated
      const w = dcWorld({ toolName: "get_config", args: () => ({}) });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("tool_not_supported");
    });

    it("refuses a tool granted under a different runtime", async () => {
      const w = dcWorld();
      const gate = withToolClasses(w.exec.authority, [{ runtime: "jace_commander", toolName: "read_file" }]);
      await w.run([
        w.dcAdapter(
          w.invoker(() => w.good()),
          gate
        )
      ]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("tool_not_permitted");
    });

    it("refuses when the authority does not grant the privilege the tool consumes", async () => {
      const w = dcWorld({ privileges: ["git.read"] });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("privilege_not_granted");
    });
  });

  describe("arguments", () => {
    it("refuses arguments that fail the tool's strict schema", async () => {
      const w = dcWorld({ args: (repo) => ({ path: join(repo, "README.md"), extra: "rm -rf /" }) });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("arguments_invalid");
    });

    it("refuses a URL read", async () => {
      const w = dcWorld({ args: () => ({ path: "https://example.com/x", isUrl: true }) });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("arguments_invalid");
    });

    it("refuses a unit without the complete call contract", async () => {
      const w = dcWorld({ payload: { argsHash: undefined } });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("call_contract_invalid");
    });
  });

  describe("path scope", () => {
    it("refuses a relative path", async () => {
      const w = dcWorld({ args: () => ({ path: "README.md" }) });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("path_not_canonical");
    });

    it("refuses a path with a parent segment", async () => {
      const w = dcWorld({ args: (repo) => ({ path: `${repo}/../../etc/passwd` }) });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("path_not_canonical");
    });

    it("refuses a path outside the authority scope", async () => {
      const w = dcWorld({ args: () => ({ path: "/etc/passwd" }) });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("path_out_of_scope");
    });

    it("does not treat a sibling that shares a path prefix as inside the scope", async () => {
      const w = dcWorld({
        scope: (repo) => [{ kind: "path", id: `${repo}x`, coverage: "descendants" }]
      });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("path_out_of_scope");
    });

    it("refuses one out-of-scope path among several", async () => {
      const w = dcWorld({
        toolName: "read_multiple_files",
        args: (repo) => ({ paths: [join(repo, "README.md"), "/etc/passwd"] })
      });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("path_out_of_scope");
    });

    it("allows a multi-file read when every path is inside the scope", async () => {
      const w = dcWorld({
        toolName: "read_multiple_files",
        args: (repo) => ({ paths: [join(repo, "README.md"), join(repo, "README.md")] })
      });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(1);
    });

    it("refuses a symlink inside the scope that points outside it", async () => {
      const w = dcWorld({ args: (repo) => ({ path: join(repo, "link") }) });
      symlinkSync("/etc", join(w.repository, "link"));
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("path_out_of_scope");
    });

    it("does not extend an exact scope to the directory's children", async () => {
      const w = dcWorld({ scope: (repo) => [{ kind: "path", id: repo, coverage: "exact" }] });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("path_out_of_scope");
    });

    it("does not let a non-filesystem scope resource cover a path", async () => {
      const w = dcWorld({
        toolName: "list_directory",
        args: (repo) => ({ path: repo }),
        scope: (repo) => [{ kind: "service", id: repo, coverage: "exact" }]
      });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("path_out_of_scope");
    });

    it("lists the scope root itself under an exact grant", async () => {
      const w = dcWorld({
        toolName: "list_directory",
        scope: (repo) => [{ kind: "path", id: repo, coverage: "exact" }],
        args: (repo) => ({ path: repo })
      });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(1);
    });

    it("reads a file under a directory granted with descendants", async () => {
      const w = dcWorld({
        scope: (repo) => [{ kind: "path", id: dirname(repo), coverage: "descendants" }]
      });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(1);
    });
  });

  describe("claim and authority at the execution boundary", () => {
    const withClaim = (inner: WorkUnitExecutorAdapter, claim: ExecutionClaim | undefined): WorkUnitExecutorAdapter => ({
      lane: inner.lane,
      execute: (dispatch, signal) => inner.execute(dispatch, signal, claim)
    });

    it("refuses a call with no claim", async () => {
      const w = dcWorld();
      await w.run([withClaim(w.dcAdapter(w.invoker(() => w.good())), undefined)]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_mismatch");
    });

    it("refuses when the claim has moved on since dispatch", async () => {
      const w = dcWorld();
      const inner = w.dcAdapter(w.invoker(() => w.good()));
      await w.run([
        {
          lane: "dc",
          execute: (dispatch, signal, claim) => {
            w.exec.missions.db
              .prepare("UPDATE coding_operations SET claim_token = 'newer' WHERE mission_id = ?")
              .run(w.item.id);
            return inner.execute(dispatch, signal, claim);
          }
        }
      ]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_not_live");
    });

    it("refuses when the grant is revoked after dispatch", async () => {
      const w = dcWorld();
      const inner = w.dcAdapter(w.invoker(() => w.good()));
      await w.run([
        {
          lane: "dc",
          execute: (dispatch, signal, claim) => {
            w.exec.items.revokeAutonomousAuthority(dispatch.authority.grantId!, "human-issuer", "stop", {
              via: "policy_gate",
              actorId: "human-issuer"
            });
            return inner.execute(dispatch, signal, claim);
          }
        }
      ]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("grant_revoked");
    });

    it("refuses a unit of another kind routed to the dc lane", async () => {
      // dispatch only checks the lane, so a desktop objective unit can reach this adapter; it is not a tool call
      const w = world({
        lane: "dc",
        unit: { kind: "desktop", payload: { kind: "desktop", objective: "open the report" } },
        toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }]
      });
      const adapter = new DcLaneExecutionAdapter(
        w.exec.missions,
        w.exec.authority,
        { invoke: () => Promise.reject(new Error("must not run")) },
        () => w.state.now
      );
      await w.run([adapter]);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_not_live");
    });
  });

  describe("runtime bound", () => {
    it("refuses a call bound longer than the authority's", async () => {
      const w = dcWorld({ maxRuntimeMs: 30_000, payload: { maxRuntimeMs: 30_001 } });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("runtime_exceeds_authority");
    });

    it("allows a call bound equal to the authority's", async () => {
      const w = dcWorld({ maxRuntimeMs: 30_000, payload: { maxRuntimeMs: 30_000 } });
      await w.run([w.dcAdapter(w.invoker(() => w.good()))]);
      expect(w.calls).toHaveLength(1);
    });

    it("stops the invoker at the call's own bound and records an unknown outcome", async () => {
      vi.useFakeTimers();
      const w = dcWorld({ payload: { maxRuntimeMs: 2_000 } });
      let aborted = false;
      const pending = w.run([
        w.dcAdapter(
          w.invoker(
            (call) =>
              new Promise<DcToolOutcome>(() => {
                call.signal.addEventListener("abort", () => {
                  aborted = true;
                });
              })
          )
        )
      ]);
      await vi.advanceTimersByTimeAsync(2_001);
      await pending;
      expect(aborted).toBe(true);
      expect(w.attempt().state).toBe("unknown");
      expect(w.attempt().category).toBe("timeout");
    });
  });

  describe("outcomes", () => {
    it("refuses a read-only tool that reports changed files", async () => {
      const w = dcWorld();
      await w.run([w.dcAdapter(w.invoker(() => ({ status: "succeeded", resultHash: "r", files: ["a.txt"] })))]);
      expect(w.unit().status).not.toBe("succeeded");
      expect(w.attempt().category).toBe("invalid_output");
      expect(w.attempt().report?.failure?.nativeCode).toBe("read_only_tool_reported_changes");
      // the call ran, so the device may have changed even though the report is unusable
      expect(w.attempt().report?.externalStateUncertain).toBe(true);
    });

    it("refuses a success with no result hash", async () => {
      const w = dcWorld();
      await w.run([w.dcAdapter(w.invoker(() => ({ status: "succeeded", resultHash: "" })))]);
      expect(w.unit().status).not.toBe("succeeded");
      expect(w.attempt().category).toBe("invalid_output");
      expect(w.attempt().report?.failure?.nativeCode).toBe("result_hash_missing");
    });

    it("maps a tool failure and redacts its message", async () => {
      const w = dcWorld();
      await w.run([
        w.dcAdapter(
          w.invoker(() => ({
            status: "failed",
            code: "ENOENT",
            message: "open failed token=ghp_supersecretvalue1234567890"
          }))
        )
      ]);
      expect(w.unit().status).toBe("failed");
      const row = w.exec.missions.db
        .prepare("SELECT report_json FROM work_unit_execution_attempts WHERE mission_id = ?")
        .get(w.item.id) as { report_json: string };
      expect(row.report_json).not.toContain("ghp_supersecretvalue");
    });

    it("records an unknown outcome as unknown, never as a success", async () => {
      const w = dcWorld();
      await w.run([w.dcAdapter(w.invoker(() => ({ status: "unknown" })))]);
      expect(w.attempt().state).toBe("unknown");
    });

    it("records an invoker that throws as a failed, uncertain attempt", async () => {
      const w = dcWorld();
      await w.run([
        w.dcAdapter(
          w.invoker(() => {
            throw new Error("transport closed");
          })
        )
      ]);
      expect(w.unit().status).not.toBe("succeeded");
      const row = w.exec.missions.db
        .prepare("SELECT report_json FROM work_unit_execution_attempts WHERE mission_id = ?")
        .get(w.item.id) as { report_json: string };
      expect(JSON.parse(row.report_json).externalStateUncertain).toBe(true);
    });

    it("does not start the invoker when the caller has already aborted", async () => {
      const w = dcWorld();
      const controller = new AbortController();
      controller.abort();
      await w.run([w.dcAdapter(w.invoker(() => w.good()))], controller.signal);
      expect(w.calls).toHaveLength(0);
    });

    it("refuses to execute another lane's dispatch", async () => {
      const w = dcWorld();
      const adapter = w.dcAdapter(w.invoker(() => w.good()));
      await expect(
        adapter.execute({ lane: "coder" } as unknown as Parameters<typeof adapter.execute>[0])
      ).rejects.toThrow(/cannot execute coder/u);
    });
  });
});
