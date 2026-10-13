import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneralCodingOutcome } from "./general-coding-adapter.js";
import { cleanupWorlds, HUMAN, SHA, world } from "./general-coding-fixture.js";
import type { ExecutionClaim, WorkUnitExecutorAdapter } from "./worker-execution.js";

afterEach(() => {
  vi.useRealTimers();
  cleanupWorlds();
});

describe("GeneralCodingExecutionAdapter", () => {
  it("runs a repository-scoped task and completes the unit with its evidence", async () => {
    const w = world();
    const outcome = await w.run([w.adapter(w.executor(() => w.good()))]);
    expect(outcome.status).toBe("executed");
    expect(w.unit().status).toBe("succeeded");
    expect(w.unit().files).toEqual(["src/a.ts", "docs/readme.md"]);
    expect(w.unit().resultHash).toBe("result-1");
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0]!.task).toMatchObject({ repository: w.repository, baseSha: SHA, maxFiles: 3 });
    expect(w.requests[0]!.claimToken).toBe(w.unit().claimToken ?? w.requests[0]!.claimToken);
  });

  it("hands the executor the live claim token as its fence", async () => {
    const w = world();
    let seen = "";
    await w.run([
      w.adapter(
        w.executor((request) => {
          seen = request.claimToken;
          return w.good();
        })
      )
    ]);
    expect(seen).not.toBe("");
    // the same token the store holds for the unit while it ran
    expect(w.requests[0]!.claimToken).toBe(seen);
  });

  describe("claim fencing at the execution boundary", () => {
    /** Wraps the adapter so the runner's claim is replaced before the adapter sees it. */
    const withClaim = (inner: WorkUnitExecutorAdapter, claim: ExecutionClaim | undefined): WorkUnitExecutorAdapter => ({
      lane: inner.lane,
      execute: (dispatch, signal) => inner.execute(dispatch, signal, claim)
    });

    it("refuses a call with no claim", async () => {
      const w = world();
      await w.run([withClaim(w.adapter(w.executor(() => w.good())), undefined)]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_mismatch");
      expect(w.unit().status).toBe("failed");
    });

    it("refuses a claim token that does not match the dispatch", async () => {
      const w = world();
      await w.run([withClaim(w.adapter(w.executor(() => w.good())), { claimToken: "someone-elses" })]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_mismatch");
    });

    it("refuses when the unit's claim has moved on since dispatch", async () => {
      const w = world();
      const inner = w.adapter(w.executor(() => w.good()));
      const stolen: WorkUnitExecutorAdapter = {
        lane: "coder",
        execute: (dispatch, signal, claim) => {
          // a newer claimant took the unit between dispatch and execution
          w.exec.missions.db
            .prepare("UPDATE coding_operations SET claim_token = 'newer', worker_id = 'other' WHERE mission_id = ?")
            .run(w.item.id);
          return inner.execute(dispatch, signal, claim);
        }
      };
      await w.run([stolen]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_not_live");
    });
  });

  describe("each part of the live claim is checked on its own", () => {
    const afterDispatch = async (change: string) => {
      const w = world();
      const inner = w.adapter(w.executor(() => w.good()));
      await w.run([
        {
          lane: "coder",
          execute: (dispatch, signal, claim) => {
            w.exec.missions.db.prepare(`UPDATE coding_operations SET ${change} WHERE mission_id = ?`).run(w.item.id);
            return inner.execute(dispatch, signal, claim);
          }
        }
      ]);
      return w;
    };

    it("refuses when only the claim token changed", async () => {
      const w = await afterDispatch("claim_token = 'newer'");
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_not_live");
    });
    it("refuses when only the worker changed", async () => {
      const w = await afterDispatch("worker_id = 'other'");
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_not_live");
    });
    it("refuses when the unit is no longer running", async () => {
      const w = await afterDispatch("status = 'pending'");
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("claim_not_live");
    });
    it("refuses when the dispatch names a different authority than the current one", async () => {
      const w = world();
      const inner = w.adapter(w.executor(() => w.good()));
      await w.run([
        {
          lane: "coder",
          execute: (dispatch, signal, claim) =>
            inner.execute(
              { ...dispatch, authority: { ...dispatch.authority, unitAuthorityHash: "f".repeat(64) } },
              signal,
              claim
            )
        }
      ]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("authority_changed");
    });
  });

  describe("authority re-checked at the execution boundary", () => {
    it("refuses when the grant is revoked after dispatch", async () => {
      const w = world();
      const inner = w.adapter(w.executor(() => w.good()));
      const revoking: WorkUnitExecutorAdapter = {
        lane: "coder",
        execute: (dispatch, signal, claim) => {
          const grantId = dispatch.authority.grantId!;
          w.exec.items.revokeAutonomousAuthority(grantId, HUMAN, "stop", { via: "policy_gate", actorId: HUMAN });
          return inner.execute(dispatch, signal, claim);
        }
      };
      await w.run([revoking]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("grant_revoked");
    });

    it("refuses when the authority expires after dispatch", async () => {
      const w = world({ expiresInMs: 5_000 });
      const inner = w.adapter(w.executor(() => w.good()));
      const lapsing: WorkUnitExecutorAdapter = {
        lane: "coder",
        execute: (dispatch, signal, claim) => {
          w.state.now = w.iso(6_000);
          return inner.execute(dispatch, signal, claim);
        }
      };
      await w.run([lapsing]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("authority_expired");
      expect(w.attempt().category).toBe("authority_expired");
    });

    it("refuses an authority that grants no sandbox runtime", async () => {
      const w = world({ toolClasses: [{ runtime: "desktop_commander", toolName: "read_file" }] });
      const outcome = await w.run([w.adapter(w.executor(() => w.good()))]);
      // the dispatch gate already refuses the coder lane, so nothing is claimed past it
      expect(outcome.status).toBe("denied");
      expect(w.requests).toHaveLength(0);
    });
  });

  describe("task contract and scope", () => {
    it("refuses a coding unit that does not carry the full contract", async () => {
      const w = world({ payload: { repository: undefined, baseSha: undefined } });
      await w.run([w.adapter(w.executor(() => w.good()))]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("task_contract_invalid");
      expect(w.unit().status).toBe("failed");
    });

    it("refuses a repository outside the authority scope", async () => {
      const w = world({
        scope: (repository) => [{ kind: "repository", id: `${repository}-other`, coverage: "exact" }]
      });
      await w.run([w.adapter(w.executor(() => w.good()))]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("repository_out_of_scope");
    });

    it("does not treat a sibling that shares a path prefix as inside the scope", async () => {
      const w = world({
        scope: (repository) => [{ kind: "repository", id: repository.slice(0, -1), coverage: "descendants" }]
      });
      await w.run([w.adapter(w.executor(() => w.good()))]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("repository_out_of_scope");
    });

    it("accepts a repository inside a descendants scope", async () => {
      const w = world({
        scope: (repository) => [{ kind: "path", id: join(repository, ".."), coverage: "descendants" }]
      });
      await w.run([w.adapter(w.executor(() => w.good()))]);
      expect(w.requests).toHaveLength(1);
      expect(w.unit().status).toBe("succeeded");
    });

    it("does not extend an exact scope to the repository's children", async () => {
      const w = world({
        scope: (repository) => [{ kind: "repository", id: join(repository, ".."), coverage: "exact" }]
      });
      await w.run([w.adapter(w.executor(() => w.good()))]);
      expect(w.requests).toHaveLength(0);
    });

    it("refuses a task bound longer than the authority's", async () => {
      const w = world({ maxRuntimeMs: 30_000, payload: { maxRuntimeMs: 30_001 } });
      await w.run([w.adapter(w.executor(() => w.good()))]);
      expect(w.requests).toHaveLength(0);
      expect(w.attempt().report?.failure?.nativeCode).toBe("runtime_exceeds_authority");
    });

    it("allows a task bound equal to the authority's", async () => {
      const w = world({ maxRuntimeMs: 30_000, payload: { maxRuntimeMs: 30_000 } });
      await w.run([w.adapter(w.executor(() => w.good()))]);
      expect(w.requests).toHaveLength(1);
    });
  });

  describe("output contract", () => {
    const rejected = async (outcome: GeneralCodingOutcome, code: string) => {
      const w = world();
      await w.run([w.adapter(w.executor(() => outcome))]);
      expect(w.unit().status).not.toBe("succeeded");
      expect(w.attempt().category).toBe("invalid_output");
      expect(w.attempt().report?.failure?.nativeCode).toBe(code);
    };

    it("rejects a result attested against a different base revision", () =>
      rejected(
        { status: "succeeded", baseSha: "b".repeat(40), resultHash: "r", files: ["src/a.ts"] },
        "base_revision_mismatch"
      ));
    it("rejects a result with no hash", () =>
      rejected({ status: "succeeded", baseSha: SHA, resultHash: "", files: ["src/a.ts"] }, "result_hash_missing"));
    it("rejects more files than the cap", () =>
      rejected(
        { status: "succeeded", baseSha: SHA, resultHash: "r", files: ["src/a.ts", "docs/1", "docs/2", "docs/3"] },
        "too_many_files"
      ));
    it("rejects a file outside the declared paths", () =>
      rejected({ status: "succeeded", baseSha: SHA, resultHash: "r", files: ["src/b.ts"] }, "file_outside_declared"));
    it("rejects a file that only shares a prefix with a declared directory", () =>
      rejected(
        { status: "succeeded", baseSha: SHA, resultHash: "r", files: ["docs-extra/x.md"] },
        "file_outside_declared"
      ));
    it("rejects a path that climbs out of the repository", () =>
      rejected(
        { status: "succeeded", baseSha: SHA, resultHash: "r", files: ["docs/../../etc/passwd"] },
        "file_path_invalid"
      ));
    it("rejects an absolute path", () =>
      rejected({ status: "succeeded", baseSha: SHA, resultHash: "r", files: ["/etc/passwd"] }, "file_path_invalid"));
    it("rejects a non-string file entry", () =>
      rejected(
        { status: "succeeded", baseSha: SHA, resultHash: "r", files: [1 as unknown as string] },
        "files_malformed"
      ));

    it("marks an output violation as possibly having changed the repository", async () => {
      const w = world();
      await w.run([
        w.adapter(w.executor(() => ({ status: "succeeded", baseSha: "c".repeat(40), resultHash: "r", files: [] })))
      ]);
      const row = w.exec.missions.db
        .prepare("SELECT report_json FROM work_unit_execution_attempts WHERE mission_id = ?")
        .get(w.item.id) as { report_json: string };
      expect(JSON.parse(row.report_json).externalStateUncertain).toBe(true);
    });
  });

  describe("outcomes and bounds", () => {
    it("maps an executor failure to a failed unit with its category", async () => {
      const w = world();
      await w.run([w.adapter(w.executor(() => ({ status: "failed", code: "conflict_stale_head" })))]);
      expect(w.unit().status).toBe("failed");
      expect(w.attempt().category).toBe("environment_changed");
    });

    it("redacts a secret in an executor's failure message", async () => {
      const w = world();
      await w.run([
        w.adapter(w.executor(() => ({ status: "failed", message: "push failed token=ghp_supersecretvalue1234567890" })))
      ]);
      const row = w.exec.missions.db
        .prepare("SELECT report_json FROM work_unit_execution_attempts WHERE mission_id = ?")
        .get(w.item.id) as { report_json: string };
      expect(row.report_json).not.toContain("ghp_supersecretvalue");
    });

    it("records an executor that throws as a failed, uncertain attempt", async () => {
      const w = world();
      await w.run([
        w.adapter(
          w.executor(() => {
            throw new Error("sandbox crashed");
          })
        )
      ]);
      expect(w.unit().status).not.toBe("succeeded");
      const row = w.exec.missions.db
        .prepare("SELECT report_json FROM work_unit_execution_attempts WHERE mission_id = ?")
        .get(w.item.id) as { report_json: string };
      expect(JSON.parse(row.report_json).externalStateUncertain).toBe(true);
    });

    it("records an unknown outcome as unknown, never as a success", async () => {
      const w = world();
      await w.run([w.adapter(w.executor(() => ({ status: "unknown" })))]);
      expect(w.attempt().state).toBe("unknown");
      expect(w.unit().status).not.toBe("succeeded");
    });

    it("stops an executor at the task's own runtime bound", async () => {
      vi.useFakeTimers();
      const w = world({ payload: { maxRuntimeMs: 2_000 } });
      let aborted = false;
      const pending = w.run([
        w.adapter(
          w.executor(
            (request) =>
              new Promise<GeneralCodingOutcome>(() => {
                request.signal.addEventListener("abort", () => {
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

    it("does not start an executor when the caller has already aborted", async () => {
      const w = world();
      const controller = new AbortController();
      controller.abort();
      await w.run([w.adapter(w.executor(() => w.good()))], controller.signal);
      expect(w.requests).toHaveLength(0);
    });

    it("refuses to execute another lane's dispatch", async () => {
      const w = world();
      const adapter = w.adapter(w.executor(() => w.good()));
      await expect(adapter.execute({ lane: "dc" } as unknown as Parameters<typeof adapter.execute>[0])).rejects.toThrow(
        /cannot execute dc/u
      );
    });
  });
});
