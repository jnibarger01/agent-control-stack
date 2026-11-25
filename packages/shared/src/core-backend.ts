import { createRequire } from "node:module";
import type { AuditChainVerification } from "./audit-chain.js";
import { verifyAuditChainFromDatabaseFile } from "./audit-export.js";

/**
 * Selects the implementation of read-only audit chain verification for one process.
 *
 * - unset, empty or `typescript`: TypeScript. The native addon is never loaded.
 * - `rust`: the acs-core addon. Fails closed: a missing, ABI-mismatched or failing addon throws.
 *   There is no silent TypeScript fallback.
 * - any other value throws at selection time.
 *
 * Authority is unchanged. This selects only how a read-only verdict is computed. TypeScript stays
 * the only writer and the only authority over the audit chain.
 */

export type CoreBackend = "typescript" | "rust";

export class CoreBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoreBackendError";
    this.code = code;
  }
}

export function coreBackendFromEnvironment(env: NodeJS.ProcessEnv = process.env): CoreBackend {
  const value = env.ACS_CORE_BACKEND?.trim() ?? "";
  if (value === "" || value === "typescript") return "typescript";
  if (value === "rust") return "rust";
  throw new CoreBackendError("ACS_CORE_BACKEND_INVALID", "ACS_CORE_BACKEND must be typescript or rust");
}

/** The Node-API surface of rust/acs-core-node. */
export interface NativeCore {
  coreAbiVersion(): number;
  verifyAuditDatabase(path: string): string;
  verifyAuditDatabaseAfter(
    path: string,
    anchorEventCount: number,
    anchorSequence: number,
    anchorHeadHash: string
  ): string;
}

const CORE_ABI_VERSION = 2;

/** A verified prefix of the audit chain: its event count, last sequence and head hash. */
export interface AuditChainAnchor {
  eventCount: number;
  sequence: number;
  headHash: string;
}
const require = createRequire(import.meta.url);

function loadPackagedCore(): NativeCore {
  return require("../native/acs_core.node") as NativeCore;
}

export interface CoreVerifierOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam. Production uses the packaged addon. */
  loadNative?: () => NativeCore;
}

/**
 * Returned by the Rust verifier when the stored data cannot establish corruption or success. `ok`
 * is null, never true or false, so no consumer can read it as a clean pass or as corruption.
 */
export interface IndeterminateVerification {
  ok: null;
  eventCount: number;
  headHash: string;
  indeterminate: {
    sequence: number;
    reason: "locale_dependent" | "locale_sensitive_mismatch" | "unsupported_canonicalization";
    locale?: string;
    path?: string;
  };
}

export type CoreVerification = AuditChainVerification | IndeterminateVerification;

export interface CoreVerifier {
  verifyAuditChainFromDatabaseFile(path: string): CoreVerification;
  /**
   * Verifies only the events after `anchor` when the anchor still holds, otherwise the whole chain. A non-ok
   * verdict is always the full verdict. It does not look behind an intact anchor, so callers keep a full
   * authoritative check. Optional: a verifier without it is always called in full.
   */
  verifyAuditChainFromDatabaseFileAfter?(path: string, anchor: AuditChainAnchor): CoreVerification;
}

export function createCoreVerifier(options: CoreVerifierOptions = {}): CoreVerifier {
  let native: NativeCore | undefined;

  const resolveNative = (): NativeCore | undefined => {
    if (coreBackendFromEnvironment(options.env ?? process.env) === "typescript") return undefined;
    if (native === undefined) {
      try {
        const candidate = (options.loadNative ?? loadPackagedCore)();
        if (
          candidate.coreAbiVersion() !== CORE_ABI_VERSION ||
          typeof candidate.verifyAuditDatabase !== "function" ||
          typeof candidate.verifyAuditDatabaseAfter !== "function"
        ) {
          throw new Error("incompatible core addon");
        }
        native = candidate;
      } catch {
        throw new CoreBackendError(
          "ACS_CORE_ADDON_UNAVAILABLE",
          "ACS core addon is missing or incompatible and ACS_CORE_BACKEND=rust requires it"
        );
      }
    }
    return native;
  };

  return {
    verifyAuditChainFromDatabaseFile(path) {
      const core = resolveNative();
      if (core === undefined) return verifyAuditChainFromDatabaseFile(path);
      let json: string;
      try {
        json = core.verifyAuditDatabase(path);
      } catch (cause) {
        // The addon throws category codes only: "store", "malformed_payload" or "hash".
        const category = cause instanceof Error ? cause.message.slice(0, 40) : "unknown";
        throw new CoreBackendError("ACS_CORE_CALL_FAILED", `ACS core verification failed (${category})`);
      }
      return JSON.parse(json) as CoreVerification;
    },
    verifyAuditChainFromDatabaseFileAfter(path, anchor) {
      const core = resolveNative();
      if (core === undefined) return verifyAuditChainFromDatabaseFile(path);
      let json: string;
      try {
        json = core.verifyAuditDatabaseAfter(path, anchor.eventCount, anchor.sequence, anchor.headHash);
      } catch (cause) {
        const category = cause instanceof Error ? cause.message.slice(0, 40) : "unknown";
        throw new CoreBackendError("ACS_CORE_CALL_FAILED", `ACS core verification failed (${category})`);
      }
      return JSON.parse(json) as CoreVerification;
    }
  };
}

const defaultVerifier = createCoreVerifier();

/** Verifies the audit chain of a database file, read-only, using the selected backend. */
export function verifyAuditChainFromDatabaseFileWithBackend(path: string): CoreVerification {
  return defaultVerifier.verifyAuditChainFromDatabaseFile(path);
}
