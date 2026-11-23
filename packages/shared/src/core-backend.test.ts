import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyAuditChainFromDatabaseFile } from "./audit-export.js";
import { coreBackendFromEnvironment, createCoreVerifier, type NativeCore } from "./core-backend.js";

const nativeEnabled = process.env.ACS_TEST_CORE_NATIVE === "1";
const historicalSource = fileURLToPath(new URL("../../../storage/local.db.bak-20261103-182951", import.meta.url));

let scratch: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function copyHistorical(): string {
  scratch = mkdtempSync(join(tmpdir(), "acs-core-backend-"));
  const copy = join(scratch, "historical.db");
  copyFileSync(historicalSource, copy);
  return copy;
}

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("audit verification backend selection", () => {
  it("selects TypeScript when unset, empty or typescript", () => {
    expect(coreBackendFromEnvironment({})).toBe("typescript");
    expect(coreBackendFromEnvironment({ ACS_CORE_BACKEND: "" })).toBe("typescript");
    expect(coreBackendFromEnvironment({ ACS_CORE_BACKEND: " typescript " })).toBe("typescript");
  });

  it("rejects any other selection", () => {
    expect(codeOf(() => coreBackendFromEnvironment({ ACS_CORE_BACKEND: "auto" }))).toBe("ACS_CORE_BACKEND_INVALID");
  });

  it("negative, typescript: never loads the addon and returns the TypeScript verdict", () => {
    const path = copyHistorical();
    const loadNative = vi.fn((): NativeCore => {
      throw new Error("must not load");
    });
    const verifier = createCoreVerifier({ env: {}, loadNative });
    expect(verifier.verifyAuditChainFromDatabaseFile(path)).toEqual(verifyAuditChainFromDatabaseFile(path));
    expect(loadNative).not.toHaveBeenCalled();
  });

  it("negative, rust: a missing addon throws and never substitutes the TypeScript verdict", () => {
    const path = copyHistorical();
    const verifier = createCoreVerifier({
      env: { ACS_CORE_BACKEND: "rust" },
      loadNative: () => {
        throw new Error("Cannot find module '/private/checkout/native/acs_core.node'");
      }
    });
    expect(codeOf(() => verifier.verifyAuditChainFromDatabaseFile(path))).toBe("ACS_CORE_ADDON_UNAVAILABLE");
  });

  it("negative, rust: an ABI-mismatched addon fails closed", () => {
    const path = copyHistorical();
    const verifier = createCoreVerifier({
      env: { ACS_CORE_BACKEND: "rust" },
      loadNative: () => ({ coreAbiVersion: () => 2, verifyAuditDatabase: () => "{}" })
    });
    expect(codeOf(() => verifier.verifyAuditChainFromDatabaseFile(path))).toBe("ACS_CORE_ADDON_UNAVAILABLE");
  });

  it("negative, rust: a failing native call throws a category-only error", () => {
    const path = copyHistorical();
    const verifier = createCoreVerifier({
      env: { ACS_CORE_BACKEND: "rust" },
      loadNative: () => ({
        coreAbiVersion: () => 1,
        verifyAuditDatabase: () => {
          throw new Error("malformed_payload");
        }
      })
    });
    let caught: unknown;
    try {
      verifier.verifyAuditChainFromDatabaseFile(path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({ code: "ACS_CORE_CALL_FAILED" }));
    expect(String((caught as Error).message)).not.toContain(path);
  });

  it("rust: returns the native verdict exactly as the addon serialized it", () => {
    const verdict = { ok: true, eventCount: 2, headHash: "ab" };
    const verifier = createCoreVerifier({
      env: { ACS_CORE_BACKEND: "rust" },
      loadNative: () => ({ coreAbiVersion: () => 1, verifyAuditDatabase: () => JSON.stringify(verdict) })
    });
    expect(verifier.verifyAuditChainFromDatabaseFile("/unused.db")).toEqual(verdict);
  });
});

describe.skipIf(!nativeEnabled)("acs-core addon parity with TypeScript (ACS_TEST_CORE_NATIVE=1)", () => {
  it("matches the TypeScript verdict on the historical chain and on a tampered copy", () => {
    const rust = createCoreVerifier({ env: { ACS_CORE_BACKEND: "rust" } });
    const path = copyHistorical();
    expect(rust.verifyAuditChainFromDatabaseFile(path)).toEqual(verifyAuditChainFromDatabaseFile(path));

    const tampered = join(scratch!, "tampered.db");
    copyFileSync(path, tampered);
    const db = new DatabaseSync(tampered);
    db.exec(
      `UPDATE audit_events SET body = '{"tampered":true}' WHERE sequence = (SELECT sequence FROM audit_events ORDER BY sequence LIMIT 1 OFFSET 2000);`
    );
    db.close();
    const native = rust.verifyAuditChainFromDatabaseFile(tampered);
    expect(native).toEqual(verifyAuditChainFromDatabaseFile(tampered));
    expect(native.ok).toBe(false);
  });
});
